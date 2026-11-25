"""Contas do painel e sessões revogáveis no volume de dados."""
import hashlib
import hmac
import re
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from .admin import _hash_senha


CONTA_INICIAL = 'painel'
TTL_SESSAO = 8 * 3600
USUARIO_VALIDO = re.compile(r'[a-z0-9][a-z0-9._-]{2,39}')
TOKEN_VALIDO = re.compile(r'[a-zA-Z0-9_-]{43}')


class Usuarios:
    def __init__(self, raiz):
        self.banco = Path(raiz) / 'dados' / 'usuarios.sqlite3'
        self.banco.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._conectar()) as con:
            con.executescript('''
                CREATE TABLE IF NOT EXISTS usuarios (
                    usuario TEXT PRIMARY KEY, nome TEXT NOT NULL,
                    salt TEXT NOT NULL, hash TEXT NOT NULL,
                    ativo INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS sessoes (
                    token TEXT PRIMARY KEY, usuario TEXT NOT NULL, expira INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessoes_usuario ON sessoes (usuario);
            ''')

    def _conectar(self):
        return sqlite3.connect(self.banco)

    def listar(self, incluir_inicial=False):
        with closing(self._conectar()) as con:
            linhas = con.execute('SELECT usuario, nome, ativo FROM usuarios ORDER BY nome, usuario').fetchall()
        contas = [{'usuario': u, 'nome': n, 'ativo': bool(a), 'inicial': False} for u, n, a in linhas]
        if incluir_inicial:
            contas.insert(0, {'usuario': CONTA_INICIAL, 'nome': 'Conta inicial', 'ativo': True, 'inicial': True})
        return contas

    def salvar(self, usuario, nome, senha='', ativo=True, *, criar):
        usuario = usuario.strip().lower()
        nome = nome.strip()
        if usuario == CONTA_INICIAL or not USUARIO_VALIDO.fullmatch(usuario):
            raise ValueError('Use de 3 a 40 caracteres no usuário. Letras, números, ponto, hífen e sublinhado são aceitos.')
        if not 1 <= len(nome) <= 100 or any(ord(c) < 32 for c in nome):
            raise ValueError('Informe um nome com até 100 caracteres.')
        if (criar or senha) and not 12 <= len(senha) <= 128:
            raise ValueError('Use uma senha de 12 a 128 caracteres.')
        if not isinstance(ativo, bool):
            raise ValueError('Situação da conta inválida.')

        credencial = _hash_senha(senha) if senha else None
        with closing(self._conectar()) as con, con:
            if criar:
                try:
                    con.execute('INSERT INTO usuarios VALUES (?, ?, ?, ?, ?)', (usuario, nome, *credencial, ativo))
                except sqlite3.IntegrityError as erro:
                    raise ValueError('Já existe uma conta com esse usuário.') from erro
                return
            if credencial:
                resultado = con.execute(
                    'UPDATE usuarios SET nome = ?, salt = ?, hash = ?, ativo = ? WHERE usuario = ?',
                    (nome, *credencial, ativo, usuario),
                )
            else:
                resultado = con.execute('UPDATE usuarios SET nome = ?, ativo = ? WHERE usuario = ?', (nome, ativo, usuario))
            if not resultado.rowcount:
                raise ValueError('Usuário não encontrado.')
            if credencial or not ativo:
                con.execute('DELETE FROM sessoes WHERE usuario = ?', (usuario,))

    @staticmethod
    def _digest(token, chave):
        return hmac.new(chave.encode(), token.encode(), hashlib.sha256).hexdigest()

    def autenticar(self, usuario, senha, chave):
        usuario = usuario.strip().lower()
        if len(senha) > 128 or not USUARIO_VALIDO.fullmatch(usuario):
            return None
        agora = int(time.time())
        token = secrets.token_urlsafe(32)
        digest = self._digest(token, chave)
        with closing(self._conectar()) as con, con:
            if usuario == CONTA_INICIAL:
                if not hmac.compare_digest(senha.encode(), chave.encode()):
                    return None
                con.execute('INSERT INTO sessoes VALUES (?, ?, ?)', (digest, usuario, agora + TTL_SESSAO))
            else:
                conta = con.execute('SELECT salt, hash FROM usuarios WHERE usuario = ? AND ativo = 1', (usuario,)).fetchone()
                salt = conta[0] if conta else '00' * 16
                _, senha_hash = _hash_senha(senha, salt)
                if not conta or not hmac.compare_digest(senha_hash, conta[1]):
                    return None
                resultado = con.execute('''
                    INSERT INTO sessoes SELECT ?, usuario, ? FROM usuarios
                    WHERE usuario = ? AND salt = ? AND hash = ? AND ativo = 1
                ''', (digest, agora + TTL_SESSAO, usuario, *conta))
                if not resultado.rowcount:
                    return None
            con.execute('DELETE FROM sessoes WHERE expira <= ?', (agora,))
        return token

    def sessao(self, token, chave):
        if not token or not TOKEN_VALIDO.fullmatch(token):
            return None
        with closing(self._conectar()) as con:
            linha = con.execute('''
                SELECT COALESCE(u.nome, s.usuario) FROM sessoes s
                LEFT JOIN usuarios u ON u.usuario = s.usuario
                WHERE s.token = ? AND s.expira > ? AND (s.usuario = ? OR u.ativo = 1)
            ''', (self._digest(token, chave), int(time.time()), CONTA_INICIAL)).fetchone()
        return linha[0] if linha else None

    def encerrar(self, token, chave):
        if token and TOKEN_VALIDO.fullmatch(token):
            with closing(self._conectar()) as con, con:
                con.execute('DELETE FROM sessoes WHERE token = ?', (self._digest(token, chave),))
