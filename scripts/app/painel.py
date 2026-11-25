"""HTML autocontido e servidor web local com API de cenarios, manutencoes e administrador."""
import base64
import calendar
from datetime import date, datetime, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import re
from urllib.parse import parse_qs, urlsplit
import webbrowser

import duckdb

from . import admin as admin_mod
from .caminhos import BANCO_PADRAO, HTML_PAINEL, PASTA_PAINEL, PASTA_SQL, caminho_tabela
from .manutencoes import CLASSIFICADORES_ONS
from .projecao_sin import CTG_POLO_FAIXA

HORAS = ('HDP', 'HDF', 'HEDP', 'HEDF', 'HRD', 'HDCE')


def registros(con, sql, parametros=None):
    cursor = con.execute(sql, parametros or [])
    nomes = [col[0] for col in cursor.description]
    return [dict(zip(nomes, linha)) for linha in cursor.fetchall()]


def _tabela_existe(con, nome):
    return con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='main' AND table_name=?",
        [nome],
    ).fetchone()[0] > 0


def coletar_dados_painel(con):
    usinas = registros(con, 'SELECT * FROM referencias_fid_ctg ORDER BY usina')
    for u in usinas:
        polo, faixa = CTG_POLO_FAIXA.get(u['cod_ceg'], ('CTG Brasil', 3))
        u['polo'] = polo
        u['faixa'] = faixa

    dados = {
        'usinas': usinas,
        'ugs': registros(con, 'SELECT cod_ceg,numero_ug AS ug,unidade,potencia_mw FROM dim_ugs_ctg ORDER BY cod_ceg,ug'),
        'horas': registros(con, 'SELECT * FROM horas_ug_mensal_ctg ORDER BY nome_usina,data,ug'),
        'mensal': registros(con, 'SELECT * FROM taxas_mensais_ctg ORDER BY usina,mes'),
        'acumulado': registros(con, 'SELECT * FROM indicadores_disponibilidade_ctg ORDER BY usina,mes_fim_historico'),
        'conciliacao': registros(con, 'SELECT * FROM conciliacao_ons ORDER BY usina,mes_fim_historico,taxa'),
        'auditoria_ugs': registros(con, 'SELECT * FROM auditoria_ugs ORDER BY usina,numero_ug'),
        'auditoria_fechamento': registros(con, 'SELECT * FROM auditoria_fechamento_horas ORDER BY usina,mes,numero_ug'),
        'manutencoes': [],
        'manutencoes_mensal': [],
        'auditoria_franquias': [],
        'classificadores_ons': CLASSIFICADORES_ONS,
        'projecao_faixas': [],
        'sin_usinas': [],
        'validacao_2022': [],
    }
    if _tabela_existe(con, 'manutencoes_programadas'):
        dados['manutencoes'] = registros(con, '''
            SELECT id_evento, polo, sigla_uhe, cod_ceg, usina, no_escopo_ons,
                   ug_str, numero_ug, ug_principal, descricao_breve, descricao_completa,
                   classificador, grupo_ons, destino_expurgo, destino_ons, tipo_manut,
                   horas_brutas, expurgo_planilha_horas, expurgo_horas, expurgo_origem,
                   retorno_diario, baseline, entra_plano, status, estagio,
                   data_inicio, data_fim, ano_inicio, duracao_dias,
                   indisponibilidade_horas, ativa_no_plano, ativa_para_calculo, observacao
            FROM manutencoes_programadas
            ORDER BY data_inicio NULLS LAST, usina, ug_str
        ''')
    if _tabela_existe(con, 'manutencoes_ug_mensal'):
        dados['manutencoes_mensal'] = registros(con, '''
            SELECT cod_ceg, usina, numero_ug AS ug, mes, horas_brutas, hdp_programado,
                   hrd_expurgado, hdce_expurgado, dias_parados, dias_hdp, horas_expurgadas,
                   qtd_eventos, tipos_manut, classificadores, tem_mod, tem_mpp, eventos_resumo
            FROM manutencoes_ug_mensal
            ORDER BY usina, mes, ug
        ''')
    if _tabela_existe(con, 'auditoria_franquias_ons'):
        dados['auditoria_franquias'] = registros(con, '''
            SELECT classificador, escopo, cod_ceg, usina, numero_ug, qtd_eventos,
                   periodo_anos, horas_brutas, horas_expurgo_declarado,
                   horas_hdp_excedente, limite_franquia_horas, saldo_franquia_horas,
                   uso_franquia_pct, status
            FROM auditoria_franquias_ons
        ''')
    if _tabela_existe(con, 'projecao_faixas_sin'):
        dados['projecao_faixas'] = registros(con, 'SELECT * FROM projecao_faixas_sin ORDER BY faixa')
    if _tabela_existe(con, 'sin_usinas_taxas_ultimas'):
        dados['sin_usinas'] = registros(con, '''
            SELECT id_sin, usina_cadastro, usina_ons, cod_ceg, faixa, ugs,
                   motorizacao, incluida, excluida, no_painel_base, mes_ons,
                   teifa_pct, teip_pct, id_atual_pct, valida_calculo, usina_ctg
            FROM sin_usinas_taxas_ultimas
            ORDER BY faixa, usina_cadastro
        ''')
    if _tabela_existe(con, 'validacao_2022_faixas'):
        dados['validacao_2022'] = registros(con, 'SELECT * FROM validacao_2022_faixas ORDER BY faixa')

    dados['mes_base'] = str(con.execute('SELECT max(mes) FROM taxas_mensais_ctg').fetchone()[0])[:7]
    dados['gerado_utc'] = datetime.now(timezone.utc).isoformat()
    return dados


def gerar_html(con, raiz):
    dados = coletar_dados_painel(con)
    texto = json.dumps(dados, ensure_ascii=False, default=str, allow_nan=False)
    texto = texto.replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    pasta = PASTA_PAINEL
    echarts_path = pasta / 'vendor/echarts.min.js'
    echarts_js = echarts_path.read_text(encoding='utf-8') if echarts_path.is_file() else ''
    logo_path = pasta / 'vendor/ctg_sphere.png'
    if not logo_path.is_file():
        logo_path = pasta / 'vendor/logo_ctg.png'
    logo_b64 = base64.b64encode(logo_path.read_bytes()).decode('ascii') if logo_path.is_file() else ''

    html = (pasta / 'modelo.html').read_text(encoding='utf-8')
    for marcador, conteudo in (
        ('__PWA_HEAD__', ''),
        ('__NATIVE_BRIDGE__', ''),
        ('__ESTILO__', (pasta / 'estilo.css').read_text(encoding='utf-8')),
        ('__LOGO_CTG__', logo_b64),
        ('__DADOS__', texto),
        ('__ECHARTS__', echarts_js),
        ('__MOTOR__', (pasta / 'motor.js').read_text(encoding='utf-8')),
        ('__APP__', (pasta / 'app.js').read_text(encoding='utf-8')),
    ):
        html = html.replace(marcador, conteudo)
    destino = Path(raiz) / HTML_PAINEL
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(html, encoding='utf-8')


def somar_meses(mes, n):
    total = mes.year * 12 + mes.month - 1 + n
    return date(total // 12, total % 12 + 1, 1)


def preparar_cenario(con, pasta, entrada):
    """Valida todas as UGs e meses; parametros ausentes projetam plena disponibilidade."""
    ceg = entrada.get('cod_ceg')
    horizonte = entrada.get('horizonte')
    if type(horizonte) is not int or not 1 <= horizonte <= 120:
        raise ValueError('O horizonte deve ser um inteiro entre 1 e 120 meses.')
    con.execute('CREATE TABLE historico AS FROM read_parquet(?)', [str(caminho_tabela('parcelas_usina_mensal_ctg', pasta))])
    ref = registros(con, 'SELECT * FROM read_parquet(?) WHERE cod_ceg=?',
                    [str(caminho_tabela('referencias_fid_ctg', pasta)), ceg])
    if len(ref) != 1:
        raise ValueError('Selecione uma usina da CTG.')
    ref = ref[0]
    base = con.execute('SELECT max(mes) FROM historico WHERE cod_ceg=?', [ceg]).fetchone()[0]
    ugs = con.execute('''SELECT ug,potencia_ug_mw FROM read_parquet(?)
        WHERE cod_ceg=? AND data=? ORDER BY ug''',
        [str(caminho_tabela('horas_ug_mensal_ctg', pasta)), ceg, base]).fetchall()
    if not ugs or any(not p or not math.isfinite(p) or p <= 0 for _, p in ugs):
        raise ValueError('Cadastro de potencia incompleto para esta usina.')
    meses = [somar_meses(base, i) for i in range(1, horizonte + 1)]
    meses_permitidos = {str(m)[:7] for m in meses}
    numeros = {u for u, _ in ugs}
    alteracoes = entrada.get('alteracoes', [])
    if not isinstance(alteracoes, list) or len(alteracoes) > len(ugs) * horizonte:
        raise ValueError('Plano de indisponibilidades invalido.')
    mapa = {}
    for linha in alteracoes:
        if not isinstance(linha, dict):
            raise ValueError('Cada indisponibilidade deve identificar UG e mes.')
        chave = (linha.get('mes'), linha.get('ug'))
        if chave[0] not in meses_permitidos or type(chave[1]) is not int or chave[1] not in numeros:
            raise ValueError('Mes ou UG fora do cenario.')
        if chave in mapa:
            raise ValueError('UG/mes duplicado no cenario.')
        valores = []
        for campo in HORAS:
            valor = linha.get(campo, 0)
            if type(valor) not in (float, int) or not math.isfinite(valor) or valor < 0:
                raise ValueError(f'{campo} deve ser um numero finito e nao negativo.')
            valores.append(float(valor))
        mapa[chave] = valores
    referencia = entrada.get('id_referencia', ref['id_referencia'])
    if type(referencia) not in (float, int) or not math.isfinite(referencia) or not 0 < referencia <= 1:
        raise ValueError('O ID de referencia deve estar entre 0 (exclusivo) e 1.')
    fonte = ref['fonte_url'] if abs(referencia - ref['id_referencia']) < 1e-12 else 'HIPOTESE_INFORMADA_NO_CENARIO'
    con.execute('''CREATE TABLE configuracao (cod_ceg VARCHAR,usina VARCHAR,mes_base DATE,
                   id_referencia DOUBLE,fonte_referencia VARCHAR)''')
    con.execute('INSERT INTO configuracao VALUES (?,?,?,?,?)', [ceg, ref['usina'], base, referencia, fonte])
    con.execute('''CREATE TABLE cenario_horas (cod_ceg VARCHAR,nome_usina VARCHAR,mes DATE,
        ug INTEGER,potencia_ug_mw DOUBLE,HDP DOUBLE,HDF DOUBLE,HEDP DOUBLE,HEDF DOUBLE,
        HRD DOUBLE,HDCE DOUBLE,HP DOUBLE,HS DOUBLE)''')
    plano = []
    for mes in meses:
        hp = calendar.monthrange(mes.year, mes.month)[1] * 24
        for ug, potencia in ugs:
            valores = mapa.get((str(mes)[:7], ug), [0.0] * 6)
            if sum(valores) > hp + 1e-7:
                raise ValueError(f'UG {ug}, {str(mes)[:7]}: a soma das horas supera HP ({hp} h).')
            plano.append((ceg, ref['usina'], mes, ug, potencia, *valores, hp, max(0, hp - sum(valores))))
    con.executemany('INSERT INTO cenario_horas VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', plano)
    con.execute((PASTA_SQL / '05_simulacao.sql').read_text(encoding='utf-8'))


def salvar_cenario(raiz, entrada):
    pasta = Path(raiz) / 'resultados'
    with duckdb.connect() as con:
        preparar_cenario(con, pasta, entrada)
        identificador = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f')
        diretorio = pasta / 'cenarios'
        diretorio.mkdir(exist_ok=True)
        arquivos = []
        for tabela in ('cenario_horas', 'resultado_cenario'):
            nome = f'{tabela}_{identificador}.parquet'
            con.execute(f'COPY {tabela} TO ? (FORMAT PARQUET, COMPRESSION ZSTD)', [str(diretorio / nome)])
            arquivos.append(nome)
    return arquivos


class ServidorPainel(BaseHTTPRequestHandler):
    esquema_http = 'http'
    habilitar_pwa = True

    def __init__(self, *args, raiz, **kwargs):
        self.raiz = Path(raiz)
        super().__init__(*args, **kwargs)

    def _origens_capacitor(self, origem):
        return origem in (
            'capacitor://localhost',
            'ionic://localhost',
            'http://localhost',
            'https://localhost',
        )

    def _origem_post_permitida(self, origem):
        return origem == f'{self.esquema_http}://{self.headers.get("Host")}' or self._origens_capacitor(origem)

    def _headers_cors(self):
        origem = self.headers.get('Origin')
        if origem and self._origens_capacitor(origem):
            return {
                'Access-Control-Allow-Origin': origem,
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        return {}

    def enviar(self, status, conteudo, tipo='application/json; charset=utf-8', arquivo=None, cookies=None):
        if not isinstance(conteudo, bytes):
            conteudo = json.dumps(conteudo, ensure_ascii=False, default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', tipo)
        self.send_header('Content-Length', str(len(conteudo)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        for k, v in self._headers_cors().items():
            self.send_header(k, v)
        if arquivo:
            self.send_header('Content-Disposition', f'attachment; filename="{arquivo}"')
        if cookies:
            for c in cookies:
                if self.esquema_http == 'https':
                    c += '; Secure'
                self.send_header('Set-Cookie', c)
        self.end_headers()
        self.wfile.write(conteudo)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in self._headers_cors().items():
            self.send_header(k, v)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _ler_json(self, limite=2_000_000):
        tamanho = int(self.headers.get('Content-Length', '0'))
        if not 0 < tamanho <= limite:
            raise ValueError('Tamanho de requisicao invalido.')
        entrada = json.loads(self.rfile.read(tamanho))
        if not isinstance(entrada, dict):
            raise ValueError('Corpo JSON invalido.')
        return entrada

    def _admin_autenticado(self):
        token = admin_mod.extrair_token_cookie(self.headers.get('Cookie'))
        return admin_mod.validar_sessao(token)

    def _exigir_admin(self):
        if not self._admin_autenticado():
            self.enviar(401, {'erro': 'Autenticacao de administrador obrigatoria.'})
            return False
        return True

    def configurar_html(self, html):
        return html

    def do_GET(self):
        parsed = urlsplit(self.path)
        caminho = parsed.path
        qs = parse_qs(parsed.query)

        if caminho in ('/', '/painel.html'):
            html_txt = (self.raiz / HTML_PAINEL).read_text(encoding='utf-8')
            if self.habilitar_pwa:
                pwa_tag = '<link rel="manifest" href="/manifest.webmanifest">\n  <script>if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(()=>{});}</script>'
                html_txt = html_txt.replace('</head>', f'  {pwa_tag}\n</head>', 1)
            self.enviar(200, self.configurar_html(html_txt).encode('utf-8'), 'text/html; charset=utf-8')
        elif caminho == '/manifest.webmanifest':
            from .mobile import gerar_manifest_json
            self.enviar(200, gerar_manifest_json().encode('utf-8'), 'application/manifest+json; charset=utf-8')
        elif caminho == '/sw.js':
            from .mobile import SERVICE_WORKER_JS
            self.enviar(200, SERVICE_WORKER_JS.encode('utf-8'), 'application/javascript; charset=utf-8')
        elif caminho in ('/icons/icon-192.png', '/icons/icon-512.png'):
            from .mobile import gerar_icone_png_bytes
            tamanho = 512 if '512' in caminho else 192
            self.enviar(200, gerar_icone_png_bytes(tamanho), 'image/png')
        elif caminho == '/api/health':
            self.enviar(200, {'ok': True})
        elif caminho == '/api/dados':
            try:
                banco = self.raiz / BANCO_PADRAO
                with duckdb.connect(str(banco), read_only=True) as con:
                    dados = coletar_dados_painel(con)
                self.enviar(200, dados)
            except Exception as erro:
                self.enviar(500, {'erro': str(erro)})
        elif caminho.startswith('/arquivos/') and re.fullmatch(r'[a-z_]+_\d{8}_\d{6}_\d{6}\.parquet', caminho[10:]):
            nome = caminho[10:]
            arquivo = self.raiz / 'resultados/cenarios' / nome
            if arquivo.is_file():
                self.enviar(200, arquivo.read_bytes(), 'application/octet-stream', nome)
            else:
                self.enviar(404, {'erro': 'Arquivo nao encontrado.'})
        elif caminho == '/api/admin/status':
            autenticado = self._admin_autenticado()
            self.enviar(200, {
                'autenticado': autenticado,
                'job': admin_mod.status_job() if autenticado else None,
            })
        elif caminho == '/api/admin/job':
            if not self._exigir_admin():
                return
            self.enviar(200, admin_mod.status_job())
        elif caminho == '/api/admin/parquets':
            if not self._exigir_admin():
                return
            try:
                self.enviar(200, {
                    'arquivos': admin_mod.listar_parquets(self.raiz),
                    'tabelas': admin_mod.resumo_tabelas_duckdb(self.raiz),
                })
            except Exception as erro:
                self.enviar(500, {'erro': str(erro)})
        elif caminho == '/api/admin/parquet/preview':
            if not self._exigir_admin():
                return
            try:
                rel = (qs.get('caminho') or [''])[0]
                limite = int((qs.get('limite') or ['100'])[0])
                offset = int((qs.get('offset') or ['0'])[0])
                filtro = (qs.get('filtro') or [''])[0]
                self.enviar(200, admin_mod.preview_parquet(self.raiz, rel, limite, offset, filtro))
            except (ValueError, FileNotFoundError) as erro:
                self.enviar(400, {'erro': str(erro)})
            except Exception as erro:
                self.enviar(500, {'erro': str(erro)})
        elif caminho == '/api/admin/parquet/download':
            if not self._exigir_admin():
                return
            try:
                rel = (qs.get('caminho') or [''])[0]
                alvo = admin_mod.resolver_parquet_seguro(self.raiz, rel)
                self.enviar(200, alvo.read_bytes(), 'application/octet-stream', alvo.name)
            except (ValueError, FileNotFoundError) as erro:
                self.enviar(404, {'erro': str(erro)})
        elif caminho == '/api/admin/config-fontes':
            if not self._exigir_admin():
                return
            self.enviar(200, admin_mod.carregar_config_fontes(self.raiz))
        else:
            self.enviar(404, {'erro': 'Pagina nao encontrada.'})

    def do_POST(self):
        origem = self.headers.get('Origin')
        if origem and not self._origem_post_permitida(origem):
            self.enviar(403, {'erro': 'Origem nao permitida.'})
            return

        caminho = urlsplit(self.path).path

        if caminho == '/api/cenario':
            try:
                entrada = self._ler_json(2_000_000)
                arquivos = salvar_cenario(self.raiz, entrada)
                self.enviar(200, {'arquivos': arquivos})
            except (ValueError, TypeError, KeyError) as erro:
                self.enviar(400, {'erro': str(erro)})
            except Exception as erro:
                print('Erro ao salvar cenario:', erro)
                self.enviar(500, {'erro': 'Nao foi possivel salvar o cenario.'})
            return

        if caminho == '/api/admin/login':
            try:
                entrada = self._ler_json(10_000)
                if not admin_mod.verificar_senha_admin(self.raiz, entrada.get('senha', '')):
                    self.enviar(401, {'erro': 'Senha incorreta.'})
                    return
                token = admin_mod.criar_sessao()
                cookie = f'calc_id_admin_session={token}; Path=/; HttpOnly; SameSite=Strict'
                self.enviar(200, {'autenticado': True, 'job': admin_mod.status_job()}, cookies=[cookie])
            except Exception as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/logout':
            token = admin_mod.extrair_token_cookie(self.headers.get('Cookie'))
            admin_mod.encerrar_sessao(token)
            cookie = 'calc_id_admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
            self.enviar(200, {'autenticado': False}, cookies=[cookie])
            return

        if not self._exigir_admin():
            return

        if caminho == '/api/admin/alterar-senha':
            try:
                entrada = self._ler_json(10_000)
                admin_mod.alterar_senha_admin(self.raiz, entrada.get('senha_atual', ''), entrada.get('nova_senha', ''))
                self.enviar(200, {'ok': True, 'mensagem': 'Senha alterada com sucesso.'})
            except ValueError as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/executar':
            try:
                entrada = self._ler_json(50_000)
                acao = entrada.get('acao', 'recalcular')
                job = admin_mod.iniciar_job_pipeline(self.raiz, acao, entrada)
                self.enviar(202, job)
            except (ValueError, RuntimeError) as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/sql':
            try:
                entrada = self._ler_json(50_000)
                res = admin_mod.executar_sql_admin(self.raiz, entrada.get('sql', ''), entrada.get('limite', 500))
                self.enviar(200, res)
            except Exception as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/sql/export':
            try:
                entrada = self._ler_json(50_000)
                csv_bytes = admin_mod.exportar_sql_csv(self.raiz, entrada.get('sql', ''))
                self.enviar(200, csv_bytes, 'text/csv; charset=utf-8', 'consulta_duckdb.csv')
            except Exception as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/config-fontes':
            try:
                entrada = self._ler_json(50_000)
                salvo = admin_mod.salvar_config_fontes(entrada, self.raiz)
                self.enviar(200, salvo)
            except ValueError as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/testar-conexao':
            try:
                entrada = self._ler_json(50_000)
                msg = admin_mod.testar_conexao_banco(entrada.get('database', entrada))
                self.enviar(200, {'ok': True, 'mensagem': msg})
            except Exception as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        if caminho == '/api/admin/upload-manutencoes':
            try:
                entrada = self._ler_json(55_000_000)
                nome = entrada.get('nome', 'manutencoes.xlsm')
                b64 = entrada.get('conteudo_base64', '')
                conteudo = base64.b64decode(b64)
                res = admin_mod.salvar_upload_manutencoes(self.raiz, nome, conteudo)
                self.enviar(200, res)
            except Exception as erro:
                self.enviar(400, {'erro': str(erro)})
            return

        self.enviar(404, {'erro': 'Operacao nao encontrada.'})

    def log_message(self, format, *args):
        pass


def servir(raiz, porta=8765, abrir=True, host='127.0.0.1'):
    with ThreadingHTTPServer((host, porta), partial(ServidorPainel, raiz=raiz)) as servidor:
        exibir_host = '127.0.0.1' if host == '0.0.0.0' else host
        url = f'http://{exibir_host}:{servidor.server_port}'
        extra = f' (LAN: http://<IP-LOCAL>:{servidor.server_port})' if host == '0.0.0.0' else ''
        print(f'Painel CTG Brasil: {url}{extra} | Ctrl+C para encerrar.', flush=True)
        if abrir:
            webbrowser.open(url)
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            pass
