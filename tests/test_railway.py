import http.client
import json
import tempfile
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

from scripts.app.caminhos import HTML_PAINEL
from scripts.app.usuarios import Usuarios
from scripts.railway import PainelRailway


class AcessoRailwayTest(unittest.TestCase):
    def setUp(self):
        pasta = self.enterContext(tempfile.TemporaryDirectory())
        self.raiz = Path(pasta)
        self.senha_inicial = 'senha-de-painel-para-teste'
        self.senha_admin = 'senha-administrativa-de-teste'
        self.enterContext(patch.dict('os.environ', {'CALC_ID_ADMIN_PASSWORD': self.senha_admin}))
        html = self.raiz / HTML_PAINEL
        html.parent.mkdir(parents=True)
        html.write_text('<main><!-- SESSAO_PAINEL --></main>', encoding='utf-8')
        handler = partial(PainelRailway, raiz=self.raiz, usuarios=Usuarios(self.raiz), senha_inicial=self.senha_inicial)
        self.servidor = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=self.servidor.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.servidor.server_close)
        self.addCleanup(self.servidor.shutdown)
        self.origem = f'https://127.0.0.1:{self.servidor.server_port}'

    def requisitar(self, metodo, caminho, dados=None, cookies='', origem=None):
        headers = {'Origin': origem or self.origem, 'Cookie': cookies}
        corpo = None
        if dados is not None:
            if caminho == '/login':
                corpo = urlencode(dados)
                headers['Content-Type'] = 'application/x-www-form-urlencoded'
            else:
                corpo = json.dumps(dados)
                headers['Content-Type'] = 'application/json'
        con = http.client.HTTPConnection('127.0.0.1', self.servidor.server_port, timeout=5)
        try:
            con.request(metodo, caminho, corpo, headers)
            resp = con.getresponse()
            return resp.status, resp.headers, resp.read().decode('utf-8')
        finally:
            con.close()

    def entrar(self, usuario, senha):
        status, headers, _ = self.requisitar('POST', '/login', {'usuario': usuario, 'senha': senha})
        self.assertEqual(status, 303)
        self.assertEqual(headers['Location'], '/')
        cookie = headers.get_all('Set-Cookie')[0]
        self.assertIn('HttpOnly', cookie)
        self.assertIn('Secure', cookie)
        return cookie.split(';', 1)[0]

    def test_login_e_saida(self):
        status, headers, _ = self.requisitar('GET', '/')
        self.assertEqual((status, headers['Location']), (303, '/login'))
        self.assertNotIn('WWW-Authenticate', headers)
        self.assertEqual(self.requisitar('GET', '/api/health')[0], 200)
        self.assertIn('Entrar no painel', self.requisitar('GET', '/login')[2])
        self.assertEqual(self.requisitar('POST', '/login', {'usuario': 'painel', 'senha': 'incorreta'})[0], 401)
        self.assertEqual(self.requisitar('POST', '/login', origem='https://outro.exemplo')[0], 403)
        cookie = self.entrar('painel', self.senha_inicial)
        self.assertIn('action="/logout"', self.requisitar('GET', '/', cookies=cookie)[2])
        self.assertEqual(self.requisitar('POST', '/logout', cookies=cookie)[0], 303)
        self.assertEqual(self.requisitar('GET', '/api/dados', cookies=cookie)[0], 401)

    def test_gestao_e_revogacao(self):
        conta = {'usuario': 'analista', 'nome': 'Ana <Silva>', 'senha': 'senha-analista-inicial', 'ativo': True, 'criar': True}
        painel = self.entrar('painel', self.senha_inicial)
        rota = '/api/admin/usuarios'
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=painel)[0], 401)
        status, headers, _ = self.requisitar('POST', '/api/admin/login', {'senha': self.senha_admin}, cookies=painel)
        self.assertEqual(status, 200)
        administrador = f"{painel}; {headers['Set-Cookie'].split(';', 1)[0]}"
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=administrador)[0], 201)
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=administrador)[0], 400)
        self.assertEqual(len(Usuarios(self.raiz).listar()), 1)
        _, _, corpo = self.requisitar('GET', rota, cookies=administrador)
        self.assertEqual(set(json.loads(corpo)['usuarios'][1]), {'usuario', 'nome', 'ativo', 'inicial'})
        cookie = self.entrar(conta['usuario'], conta['senha'])
        self.assertIn('Ana &lt;Silva&gt;', self.requisitar('GET', '/', cookies=cookie)[2])
        conta.update(criar=False, senha='nova-senha-analista')
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=administrador)[0], 200)
        self.assertEqual(self.requisitar('GET', '/', cookies=cookie)[0], 303)
        cookie = self.entrar(conta['usuario'], conta['senha'])
        conta.update(ativo=False, senha='')
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=administrador)[0], 200)
        self.assertEqual(self.requisitar('GET', '/', cookies=cookie)[0], 303)
        self.assertEqual(self.requisitar('POST', '/login', {'usuario': 'analista', 'senha': 'nova-senha-analista'})[0], 401)
        conta['ativo'] = True
        self.assertEqual(self.requisitar('POST', rota, conta, cookies=administrador)[0], 200)
        self.entrar('analista', 'nova-senha-analista')
