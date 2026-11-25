"""Servidor do painel hospedado no Railway."""
import base64
import hmac
import os
from functools import partial
from http.server import ThreadingHTTPServer

from scripts.app.caminhos import RAIZ
from scripts.app.painel import ServidorPainel


class PainelRailway(ServidorPainel):
    esquema_http = 'https'
    habilitar_pwa = False

    def __init__(self, *args, credencial, **kwargs):
        self.credencial = credencial
        super().__init__(*args, **kwargs)

    def _origens_capacitor(self, origem):
        return False

    def acesso_autorizado(self):
        esquema, _, valor = self.headers.get('Authorization', '').partition(' ')
        if esquema.lower() == 'basic' and hmac.compare_digest(valor.encode(), self.credencial):
            return True
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="Disponibilidade CTG", charset="UTF-8"')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return False

    def do_GET(self):
        if self.path == '/api/health' or self.acesso_autorizado():
            super().do_GET()

    def do_POST(self):
        if self.acesso_autorizado():
            super().do_POST()

    def do_OPTIONS(self):
        if self.acesso_autorizado():
            super().do_OPTIONS()


def main():
    senha = os.environ['CALC_ID_WEB_PASSWORD']
    if not senha or not os.environ.get('CALC_ID_ADMIN_PASSWORD'):
        raise SystemExit('Defina as senhas do painel e do administrador.')
    credencial = base64.b64encode(f'painel:{senha}'.encode())
    handler = partial(PainelRailway, raiz=RAIZ, credencial=credencial)
    with ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), handler) as servidor:
        print(f'Painel pronto na porta {servidor.server_port}', flush=True)
        servidor.serve_forever()


if __name__ == '__main__':
    main()
