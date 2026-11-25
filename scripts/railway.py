"""Servidor do painel autenticado no Railway."""
import os
from functools import partial
from html import escape
from http.cookies import CookieError, SimpleCookie
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from scripts.app import admin
from scripts.app.caminhos import PASTA_PAINEL, RAIZ
from scripts.app.painel import ServidorPainel
from scripts.app.usuarios import TTL_SESSAO, Usuarios


COOKIE_SESSAO = 'calc_id_painel_session'
COOKIES_SEGUROS = 'Path=/; HttpOnly; SameSite=Lax; Secure'
LIMPAR_ADMIN = 'calc_id_admin_session=; Max-Age=0'


class PainelRailway(ServidorPainel):
    esquema_http = 'https'
    habilitar_pwa = False

    def __init__(self, *args, usuarios, senha_inicial, **kwargs):
        self.usuarios = usuarios
        self.senha_inicial = senha_inicial
        super().__init__(*args, **kwargs)

    def _origens_capacitor(self, origem):
        return False

    def _token_painel(self):
        try:
            item = SimpleCookie(self.headers.get('Cookie', '')).get(COOKIE_SESSAO)
            return item.value if item else None
        except CookieError:
            return None

    def _redirecionar(self, caminho, cookies=()):
        self.send_response(303)
        self.send_header('Location', caminho)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        for cookie in cookies:
            self.send_header('Set-Cookie', f'{cookie}; {COOKIES_SEGUROS}')
        self.end_headers()

    def _tela_login(self, status=200, erro='', usuario=''):
        html = (PASTA_PAINEL / 'login.html').read_text(encoding='utf-8')
        mensagem = f'<p class="erro" role="alert">{escape(erro)}</p>' if erro else ''
        html = html.replace('<!-- ERRO_LOGIN -->', mensagem).replace('__USUARIO__', escape(usuario, quote=True))
        self.enviar(status, html.encode('utf-8'), 'text/html; charset=utf-8')

    def _encerrar_sessoes(self):
        self.usuarios.encerrar(self._token_painel(), self.senha_inicial)
        admin.encerrar_sessao(admin.extrair_token_cookie(self.headers.get('Cookie')))

    def _login(self):
        try:
            tamanho = int(self.headers.get('Content-Length', '0'))
            if not 0 < tamanho <= 4096 or self.headers.get_content_type() != 'application/x-www-form-urlencoded':
                raise ValueError
            campos = parse_qs(self.rfile.read(tamanho).decode(), max_num_fields=2)
            usuario = campos.get('usuario', [''])[0]
            senha = campos.get('senha', [''])[0]
        except ValueError:
            self._tela_login(400, 'Confira os dados e tente novamente.')
            return
        token = self.usuarios.autenticar(usuario, senha, self.senha_inicial)
        if not token:
            self._tela_login(401, 'Usuário ou senha inválidos.', usuario[:40])
            return
        self._encerrar_sessoes()
        self._redirecionar('/', (f'{COOKIE_SESSAO}={token}; Max-Age={TTL_SESSAO}', LIMPAR_ADMIN))

    def _exigir_painel(self, caminho):
        self.nome_conta = self.usuarios.sessao(self._token_painel(), self.senha_inicial)
        if self.nome_conta:
            return True
        if caminho.startswith('/api/'):
            self.enviar(401, {'erro': 'Sessão do painel encerrada.', 'sessao_expirada': True})
        else:
            self._redirecionar('/login')
        return False

    def configurar_html(self, html):
        sessao = (
            '<form id="sessao-painel" class="sessao-painel" method="post" action="/logout">'
            f'<span>{escape(self.nome_conta)}</span><button type="submit" class="btn secondary">Sair</button>'
            '</form>'
        )
        mobile = (
            '<form method="post" action="/logout">'
            '<button type="submit" class="mob-logout-pill" aria-label="Sair do painel">Sair</button>'
            '</form>'
        )
        return html.replace('<!-- SESSAO_PAINEL -->', sessao).replace('<!-- SESSAO_PAINEL_MOBILE -->', mobile)

    def _salvar_usuario(self):
        if not self._exigir_admin():
            return
        try:
            dados = self._ler_json(4096)
            usuario, nome = dados.get('usuario'), dados.get('nome')
            senha, criar, ativo = dados.get('senha', ''), dados.get('criar'), dados.get('ativo')
            if not all(isinstance(valor, str) for valor in (usuario, nome, senha)) or not isinstance(criar, bool):
                raise ValueError('Confira os dados do usuário.')
            self.usuarios.salvar(usuario, nome, senha, ativo, criar=criar)
            self.enviar(201 if criar else 200, {'ok': True})
        except ValueError as erro:
            self.enviar(400, {'erro': str(erro)})

    def do_GET(self):
        caminho = urlsplit(self.path).path
        if caminho == '/api/health':
            super().do_GET()
        elif caminho == '/login':
            if self.usuarios.sessao(self._token_painel(), self.senha_inicial):
                self._redirecionar('/')
            else:
                self._tela_login()
        elif caminho == '/login.css':
            self.enviar(200, (PASTA_PAINEL / 'login.css').read_bytes(), 'text/css; charset=utf-8')
        elif caminho == '/login-logo.png':
            self.enviar(200, (PASTA_PAINEL / 'vendor/logo_ctg.png').read_bytes(), 'image/png')
        elif self._exigir_painel(caminho):
            if caminho == '/api/admin/usuarios':
                if self._exigir_admin():
                    self.enviar(200, {'usuarios': self.usuarios.listar(incluir_inicial=True)})
            else:
                super().do_GET()

    def do_POST(self):
        caminho = urlsplit(self.path).path
        if not self._origem_post_permitida(self.headers.get('Origin')):
            self.enviar(403, {'erro': 'Origem não permitida.'})
            return
        if caminho == '/login':
            self._login()
        elif caminho == '/logout':
            self._encerrar_sessoes()
            self._redirecionar('/login', (f'{COOKIE_SESSAO}=; Max-Age=0', LIMPAR_ADMIN))
        elif self._exigir_painel(caminho):
            if caminho == '/api/admin/usuarios':
                self._salvar_usuario()
            else:
                super().do_POST()

    def do_OPTIONS(self):
        if self._exigir_painel(urlsplit(self.path).path):
            super().do_OPTIONS()


def main():
    senha = os.environ['CALC_ID_WEB_PASSWORD']
    if not senha or not os.environ.get('CALC_ID_ADMIN_PASSWORD'):
        raise SystemExit('Defina as senhas do painel e do administrador.')
    handler = partial(PainelRailway, raiz=RAIZ, usuarios=Usuarios(RAIZ), senha_inicial=senha)
    with ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), handler) as servidor:
        print(f'Painel pronto na porta {servidor.server_port}', flush=True)
        servidor.serve_forever()


if __name__ == '__main__':
    main()
