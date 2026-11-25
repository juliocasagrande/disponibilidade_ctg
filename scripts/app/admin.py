"""Autenticacao, execucao de scripts, configuracao de fontes e explorador Parquet/SQL."""
import csv
from datetime import datetime, timezone
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time

import duckdb

from .caminhos import BANCO_PADRAO, CONFIG_ADMIN, PASTA_DADOS, PASTA_RESULTADOS
from .manutencoes import (
    carregar_config_fontes,
    ler_excel_manutencoes,
    salvar_config_fontes,
    testar_conexao_banco,
)

SENHA_PADRAO_ADMIN = 'ctg@admin2026'
TTL_SESSAO_SEGUNDOS = 8 * 3600
ITERACOES_PBKDF2 = 120_000

_SESSOES = {}
_SESSOES_LOCK = threading.Lock()

_JOB_LOCK = threading.Lock()
_JOB_ATUAL = {
    'id': None,
    'acao': None,
    'status': 'idle',  # idle, running, success, error
    'inicio_utc': None,
    'fim_utc': None,
    'codigo_saida': None,
    'logs': [],
}


def _hash_senha(senha, salt_hex=None):
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac('sha256', senha.encode('utf-8'), salt, ITERACOES_PBKDF2)
    return salt.hex(), dk.hex()


def _carregar_ou_criar_admin_cfg(raiz):
    caminho = Path(raiz) / 'dados/admin_config.json'
    if caminho.is_file():
        try:
            cfg = json.loads(caminho.read_text(encoding='utf-8'))
            if cfg.get('salt') and cfg.get('hash'):
                return cfg
        except Exception:
            pass
    salt, h = _hash_senha(SENHA_PADRAO_ADMIN)
    cfg = {
        'salt': salt,
        'hash': h,
        'atualizado_utc': datetime.now(timezone.utc).isoformat(),
        'senha_padrao_ativa': True,
    }
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    return cfg


def verificar_senha_admin(raiz, senha):
    if not isinstance(senha, str) or not senha:
        return False
    env_pass = os.environ.get('CALC_ID_ADMIN_PASSWORD')
    if env_pass:
        return hmac.compare_digest(senha, env_pass)
    cfg = _carregar_ou_criar_admin_cfg(raiz)
    _, esperado = _hash_senha(senha, cfg['salt'])
    return hmac.compare_digest(esperado, cfg['hash'])


def alterar_senha_admin(raiz, senha_atual, nova_senha):
    if not verificar_senha_admin(raiz, senha_atual):
        raise ValueError('Senha atual incorreta.')
    if not isinstance(nova_senha, str) or len(nova_senha) < 6:
        raise ValueError('A nova senha deve ter pelo menos 6 caracteres.')
    salt, h = _hash_senha(nova_senha)
    caminho = Path(raiz) / 'dados/admin_config.json'
    cfg = {
        'salt': salt,
        'hash': h,
        'atualizado_utc': datetime.now(timezone.utc).isoformat(),
        'senha_padrao_ativa': False,
    }
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
    return True


def criar_sessao():
    token = secrets.token_urlsafe(32)
    with _SESSOES_LOCK:
        _SESSOES[token] = time.time() + TTL_SESSAO_SEGUNDOS
    return token


def validar_sessao(token):
    if not token:
        return False
    agora = time.time()
    with _SESSOES_LOCK:
        expira = _SESSOES.get(token)
        if expira is None:
            return False
        if agora > expira:
            _SESSOES.pop(token, None)
            return False
        return True


def encerrar_sessao(token):
    if not token:
        return
    with _SESSOES_LOCK:
        _SESSOES.pop(token, None)


def extrair_token_cookie(header_cookie):
    if not header_cookie:
        return None
    for parte in header_cookie.split(';'):
        k, _, v = parte.strip().partition('=')
        if k == 'calc_id_admin_session':
            return v.strip()
    return None


def status_job():
    with _JOB_LOCK:
        return {
            'id': _JOB_ATUAL['id'],
            'acao': _JOB_ATUAL['acao'],
            'status': _JOB_ATUAL['status'],
            'inicio_utc': _JOB_ATUAL['inicio_utc'],
            'fim_utc': _JOB_ATUAL['fim_utc'],
            'codigo_saida': _JOB_ATUAL['codigo_saida'],
            'logs': list(_JOB_ATUAL['logs']),
        }


def iniciar_job_pipeline(raiz, acao, parametros=None):
    """Dispara execucao do pipeline em background e captura os logs."""
    parametros = parametros or {}
    raiz = Path(raiz)
    cmd = [sys.executable, '-u', str(raiz / 'scripts/executar.py')]

    if acao == 'recalcular':
        pass
    elif acao == 'atualizar_ons':
        cmd.append('--atualizar')
        ano_ini = parametros.get('ano_inicial')
        ano_fim = parametros.get('ano_final')
        if ano_ini is not None:
            cmd.extend(['--ano-inicial', str(int(ano_ini))])
        if ano_fim is not None:
            cmd.extend(['--ano-final', str(int(ano_fim))])
        ref_url = (parametros.get('referencias_url') or '').strip()
        if ref_url:
            cmd.extend(['--referencias-url', ref_url])
    elif acao == 'somente_baixar':
        cmd.append('--somente-baixar')
        ano_ini = parametros.get('ano_inicial')
        ano_fim = parametros.get('ano_final')
        if ano_ini is not None:
            cmd.extend(['--ano-inicial', str(int(ano_ini))])
        if ano_fim is not None:
            cmd.extend(['--ano-final', str(int(ano_fim))])
    else:
        raise ValueError(f'Acao nao reconhecida: {acao}')

    with _JOB_LOCK:
        if _JOB_ATUAL['status'] == 'running':
            raise RuntimeError('Ja existe uma atualizacao em andamento. Aguarde a conclusao.')
        job_id = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
        _JOB_ATUAL.update({
            'id': job_id,
            'acao': acao,
            'status': 'running',
            'inicio_utc': datetime.now(timezone.utc).isoformat(),
            'fim_utc': None,
            'codigo_saida': None,
            'logs': [f'[{job_id}] Iniciando: {" ".join(cmd)}'],
        })

    def _runner():
        env = os.environ.copy()
        env['PYTHONIOENCODING'] = 'utf-8'
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(raiz),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                env=env,
            )
            assert proc.stdout is not None
            for linha in proc.stdout:
                with _JOB_LOCK:
                    _JOB_ATUAL['logs'].append(linha.rstrip('\r\n'))
                    if len(_JOB_ATUAL['logs']) > 800:
                        _JOB_ATUAL['logs'] = _JOB_ATUAL['logs'][-800:]
            codigo = proc.wait()
            with _JOB_LOCK:
                _JOB_ATUAL['codigo_saida'] = codigo
                _JOB_ATUAL['status'] = 'success' if codigo == 0 else 'error'
                _JOB_ATUAL['fim_utc'] = datetime.now(timezone.utc).isoformat()
                _JOB_ATUAL['logs'].append(
                    'Concluido com sucesso.' if codigo == 0 else f'Finalizado com erro (codigo {codigo}).'
                )
        except Exception as erro:
            with _JOB_LOCK:
                _JOB_ATUAL['codigo_saida'] = -1
                _JOB_ATUAL['status'] = 'error'
                _JOB_ATUAL['fim_utc'] = datetime.now(timezone.utc).isoformat()
                _JOB_ATUAL['logs'].append(f'Excecao ao executar script: {erro}')

    threading.Thread(target=_runner, daemon=True).start()
    return status_job()


def _raizes_parquet_permitidas(raiz):
    raiz = Path(raiz).resolve()
    return [raiz / 'dados', raiz / 'resultados']


def resolver_parquet_seguro(raiz, caminho_relativo):
    """Garante que o caminho aponta para um .parquet dentro de dados/ ou resultados/."""
    raiz = Path(raiz).resolve()
    if not caminho_relativo or '..' in Path(caminho_relativo).parts:
        raise ValueError('Caminho Parquet invalido.')
    alvo = (raiz / caminho_relativo).resolve()
    if alvo.suffix.lower() != '.parquet' or not alvo.is_file():
        raise FileNotFoundError('Arquivo Parquet nao encontrado.')
    permitidas = _raizes_parquet_permitidas(raiz)
    if not any(p.resolve() in alvo.parents for p in permitidas):
        raise ValueError('Acesso fora das pastas permitidas.')
    return alvo


def listar_parquets(raiz):
    raiz = Path(raiz).resolve()
    itens = []
    with duckdb.connect() as con:
        for base in _raizes_parquet_permitidas(raiz):
            if not base.exists():
                continue
            for arquivo in sorted(base.rglob('*.parquet')):
                rel = arquivo.relative_to(raiz).as_posix()
                stat = arquivo.stat()
                linhas = None
                colunas = None
                try:
                    linhas = con.execute('SELECT count(*) FROM read_parquet(?)', [str(arquivo)]).fetchone()[0]
                    colunas = len(con.execute('DESCRIBE SELECT * FROM read_parquet(?)', [str(arquivo)]).fetchall())
                except Exception:
                    pass
                partes = arquivo.relative_to(raiz).parts
                categoria = '/'.join(partes[:-1])
                itens.append({
                    'caminho': rel,
                    'nome': arquivo.name,
                    'categoria': categoria,
                    'tamanho_bytes': stat.st_size,
                    'modificado_utc': datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                    'linhas': linhas,
                    'colunas': colunas,
                })
    return itens


def preview_parquet(raiz, caminho_relativo, limite=100, offset=0, filtro=''):
    alvo = resolver_parquet_seguro(raiz, caminho_relativo)
    limite = max(1, min(int(limite), 500))
    offset = max(0, int(offset))
    filtro = (filtro or '').strip()

    with duckdb.connect() as con:
        esquema_raw = con.execute('DESCRIBE SELECT * FROM read_parquet(?)', [str(alvo)]).fetchall()
        esquema = [{'coluna': r[0], 'tipo': r[1], 'nulo': r[2]} for r in esquema_raw]
        colunas = [r[0] for r in esquema_raw]

        total = con.execute('SELECT count(*) FROM read_parquet(?)', [str(alvo)]).fetchone()[0]

        if filtro:
            cond = ' OR '.join(
                f'lower(coalesce(CAST("{c.replace(chr(34), chr(34)*2)}" AS VARCHAR), \'\')) LIKE ?'
                for c in colunas
            )
            padrao = f'%{filtro.lower()}%'
            params_filtro = [str(alvo)] + [padrao] * len(colunas)
            total_filtrado = con.execute(
                f'SELECT count(*) FROM read_parquet(?) WHERE {cond}', params_filtro
            ).fetchone()[0]
            cur = con.execute(
                f'SELECT * FROM read_parquet(?) WHERE {cond} LIMIT ? OFFSET ?',
                params_filtro + [limite, offset],
            )
        else:
            total_filtrado = total
            cur = con.execute(
                'SELECT * FROM read_parquet(?) LIMIT ? OFFSET ?',
                [str(alvo), limite, offset],
            )

        registros = [
            [_serializar_celula(v) for v in linha]
            for linha in cur.fetchall()
        ]

    return {
        'caminho': caminho_relativo,
        'nome': alvo.name,
        'total_linhas': total,
        'total_filtrado': total_filtrado,
        'limite': limite,
        'offset': offset,
        'esquema': esquema,
        'colunas': colunas,
        'linhas': registros,
    }


def _serializar_celula(v):
    if v is None:
        return None
    if isinstance(v, (bool, int)):
        return v
    if isinstance(v, float):
        return v if v == v else None
    return str(v)


_PROIBIDO_SQL = re.compile(
    r'\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|COPY|ATTACH|DETACH|INSTALL|LOAD|CALL|SET|EXPORT|IMPORT|PRAGMA)\b',
    re.I,
)


def _validar_sql_somente_leitura(sql):
    limpo = (sql or '').strip()
    if not limpo:
        raise ValueError('Informe uma consulta SQL.')
    if len(limpo) > 15_000:
        raise ValueError('Consulta SQL muito extensa (limite: 15.000 caracteres).')
    # Remove comentarios SQL simples antes da validacao
    sem_comentarios = re.sub(r'--[^\n]*', ' ', limpo)
    sem_comentarios = re.sub(r'/\*.*?\*/', ' ', sem_comentarios, flags=re.S).strip()
    if sem_comentarios.endswith(';'):
        sem_comentarios = sem_comentarios[:-1].strip()
    if ';' in sem_comentarios:
        raise ValueError('Execute apenas uma consulta por vez (sem multiplos comandos separados por ";").')
    # Remove literais entre aspas simples para checar palavras-chave
    sem_strings = re.sub(r"'(?:''|[^'])*'", "''", sem_comentarios)
    if _PROIBIDO_SQL.search(sem_strings):
        raise ValueError('Apenas consultas de leitura (SELECT, WITH, DESCRIBE, SHOW, SUMMARIZE, EXPLAIN) sao permitidas.')
    inicio = sem_strings.lstrip('(').split(None, 1)[0].upper() if sem_strings else ''
    if inicio not in ('SELECT', 'WITH', 'DESCRIBE', 'SHOW', 'SUMMARIZE', 'EXPLAIN', 'FROM', 'TABLE'):
        raise ValueError('A consulta deve iniciar com SELECT, WITH, FROM, DESCRIBE, SHOW ou SUMMARIZE.')
    return sem_comentarios


def executar_sql_admin(raiz, sql, limite=500):
    """Executa SQL somente leitura no DuckDB do projeto (com tabelas + read_parquet)."""
    raiz = Path(raiz).resolve()
    consulta = _validar_sql_somente_leitura(sql)
    limite = max(1, min(int(limite), 50_000))
    banco = raiz / BANCO_PADRAO

    t0 = time.perf_counter()
    cwd_anterior = os.getcwd()
    try:
        os.chdir(raiz)
        if banco.is_file():
            con = duckdb.connect(str(banco), read_only=True)
        else:
            con = duckdb.connect()
        try:
            cur = con.execute(consulta)
            colunas = [d[0] for d in (cur.description or [])]
            linhas_raw = cur.fetchmany(limite + 1)
            truncado = len(linhas_raw) > limite
            if truncado:
                linhas_raw = linhas_raw[:limite]
            linhas = [[_serializar_celula(v) for v in row] for row in linhas_raw]
        finally:
            con.close()
    finally:
        os.chdir(cwd_anterior)

    duracao_ms = round((time.perf_counter() - t0) * 1000, 1)
    return {
        'colunas': colunas,
        'linhas': linhas,
        'quantidade': len(linhas),
        'truncado': truncado,
        'duracao_ms': duracao_ms,
    }


def exportar_sql_csv(raiz, sql):
    res = executar_sql_admin(raiz, sql, limite=50_000)
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=';')
    writer.writerow(res['colunas'])
    for row in res['linhas']:
        writer.writerow(['' if v is None else v for v in row])
    return buf.getvalue().encode('utf-8-sig')


def salvar_upload_manutencoes(raiz, nome_arquivo, conteudo_bytes):
    """Valida e salva uma nova planilha Excel de manutencoes programadas."""
    raiz = Path(raiz).resolve()
    nome_limpo = Path(nome_arquivo or 'manutencoes.xlsx').name
    ext = Path(nome_limpo).suffix.lower()
    if ext not in ('.xlsx', '.xlsm'):
        raise ValueError('Envie um arquivo Excel (.xlsx ou .xlsm).')
    if not conteudo_bytes or len(conteudo_bytes) > 40_000_000:
        raise ValueError('Tamanho do arquivo invalido (maximo 40 MB).')

    pasta = raiz / 'dados/manutencoes'
    pasta.mkdir(parents=True, exist_ok=True)
    tmp = pasta / f'_upload_{secrets.token_hex(6)}{ext}'
    tmp.write_bytes(conteudo_bytes)
    try:
        cfg = carregar_config_fontes(raiz)
        eventos = ler_excel_manutencoes(tmp, cfg.get('excel_aba', 'Plano'))
        if not eventos:
            raise ValueError('Nenhum registro valido foi encontrado na aba Plano.')
        destino = pasta / 'Manutencoes_e_Modernizacoes_CTG_Brasil_Plurianual.xlsm'
        if ext == '.xlsx':
            destino = pasta / 'Manutencoes_e_Modernizacoes_CTG_Brasil_Plurianual.xlsx'
        tmp.replace(destino)
        salvar_config_fontes(
            {'origem_manutencoes': 'excel', 'excel_caminho': destino.relative_to(raiz).as_posix()},
            raiz,
        )
        return {
            'arquivo': destino.relative_to(raiz).as_posix(),
            'eventos_lidos': len(eventos),
            'eventos_ativos_ons': sum(1 for e in eventos if e['ativa_para_calculo']),
        }
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def resumo_tabelas_duckdb(raiz):
    raiz = Path(raiz).resolve()
    banco = raiz / BANCO_PADRAO
    if not banco.is_file():
        return []
    with duckdb.connect(str(banco), read_only=True) as con:
        rows = con.execute('''
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_schema = 'main'
            ORDER BY table_type, table_name
        ''').fetchall()
    return [{'nome': r[0], 'tipo': r[1]} for r in rows]


__all__ = [
    'SENHA_PADRAO_ADMIN',
    'verificar_senha_admin',
    'alterar_senha_admin',
    'criar_sessao',
    'validar_sessao',
    'encerrar_sessao',
    'extrair_token_cookie',
    'status_job',
    'iniciar_job_pipeline',
    'listar_parquets',
    'preview_parquet',
    'resolver_parquet_seguro',
    'executar_sql_admin',
    'exportar_sql_csv',
    'salvar_upload_manutencoes',
    'resumo_tabelas_duckdb',
    'carregar_config_fontes',
    'salvar_config_fontes',
    'testar_conexao_banco',
]
