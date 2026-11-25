"""QA opcional: requer Playwright e Microsoft Edge instalados."""
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
import threading
from urllib.parse import urlsplit

import duckdb
from playwright.sync_api import sync_playwright

from scripts.app.caminhos import HTML_PAINEL
from scripts.app.painel import ServidorPainel, preparar_cenario


def main():
    raiz = Path(__file__).resolve().parents[1]
    evidencias = raiz/'resultados/validacoes/painel'
    evidencias.mkdir(parents=True,exist_ok=True)
    erros, criados = [], []
    servidor = ThreadingHTTPServer(('127.0.0.1',0),partial(ServidorPainel,raiz=raiz))
    threading.Thread(target=servidor.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True,channel='msedge')
            page = browser.new_page(viewport={'width':1440,'height':1080})
            page.on('pageerror',lambda erro:erros.append(str(erro)))
            page.goto((raiz/HTML_PAINEL).as_uri())
            assert page.locator('#tabela-atual tbody tr').count()==12
            assert page.locator('#tabela-horas tbody tr').count()==68
            page.screenshot(path=str(evidencias/'qa_atual.png'),full_page=True)
            page.select_option('#usina','UHE.PH.SP.001120-7.01')
            assert page.locator('#tabela-horas tbody tr').count()==20
            page.click('#aba-simulacao')
            assert page.locator('#tabela-editor tbody tr').count()==20
            editor = page.locator('input[data-ug="1"][data-campo="HDP"]')
            editor.fill('1000')
            assert page.locator('#erro-simulacao').is_visible()
            editor.fill('100')
            assert not page.locator('#erro-simulacao').is_visible()
            assert page.locator('#tabela-simulacao tbody tr').count()==12
            page.screenshot(path=str(evidencias/'qa_simulacao.png'),full_page=True)
            dados = page.evaluate("JSON.parse(document.getElementById('dados-painel').textContent)")
            mes = page.evaluate('MotorCTG.moverMes("'+dados['mes_base']+'",1)')
            for usina in dados['usinas']:
                ceg = usina['cod_ceg']
                alteracoes = [dict(mes=mes,ug=1,HDP=48,HEDF=3,HRD=2)]
                with duckdb.connect() as con:
                    preparar_cenario(con,raiz/'resultados',dict(cod_ceg=ceg,horizonte=72,alteracoes=alteracoes))
                    sql = con.execute('SELECT teifa,teip,id_verificado,fid_bruto,fid_mra FROM resultado_cenario '
                                      'ORDER BY mes_fim_historico').fetchall()
                js = page.evaluate('''([dados,ceg,mes])=>MotorCTG.projetar(dados,ceg,72,
                    {[mes+'|1']:{HDP:48,HEDF:3,HRD:2}}).resultados.map(
                    r=>[r.teifa,r.teip,r.id_verificado,r.fid_bruto,r.fid_mra])''',[dados,ceg,mes])
                assert len(sql)==len(js)==72
                for linha_sql, linha_js in zip(sql,js):
                    for x,y in zip(linha_sql,linha_js):
                        assert (x is None and y is None) or (x is not None and y is not None and abs(x-y)<1e-12),(ceg,x,y)
            page.set_viewport_size({'width':390,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
            assert page.locator('#mob-bottom-nav').is_visible()
            assert page.locator('#mob-filter-strip').is_visible()
            page.click('#mob-btn-filtros')
            assert page.locator('#sidebar.open').is_visible()
            page.click('#mob-sheet-apply')
            page.click('#mob-tab-simulacao')
            assert page.locator('#simulacao').is_visible()
            page.set_viewport_size({'width':1440,'height':1080})
            page.goto(f'http://127.0.0.1:{servidor.server_port}')
            page.select_option('#usina','UHE.PH.SP.000647-5.01')
            page.click('#aba-simulacao')
            page.locator('input[data-ug="1"][data-campo="HDP"]').fill('50')
            page.click('#salvar-cenario')
            page.wait_for_selector('#estado-salvar a')
            links = page.locator('#estado-salvar a').evaluate_all('(els)=>els.map(e=>e.href)')
            assert len(links)==2
            for url in links:
                nome = urlsplit(url).path.split('/')[-1]
                arquivo = raiz/'resultados/cenarios'/nome
                criados.append(arquivo)
                assert arquivo.read_bytes().startswith(b'PAR1')
                assert page.request.get(url).status==200
            with duckdb.connect() as con:
                assert con.execute('SELECT count(*) FROM read_parquet(?)',[str(criados[0])]).fetchone()[0]==36
                assert con.execute('SELECT count(*) FROM read_parquet(?)',[str(criados[1])]).fetchone()[0]==12
            browser.close()
        assert not erros,erros
        print('Interface, filtros, validacao de horas, tela movel e exportacao Parquet: OK.')
        print('Paridade JS/SQL: 12 usinas x 72 meses x 5 indices = 4.320 comparacoes OK.')
    finally:
        servidor.shutdown()
        servidor.server_close()
        for arquivo in criados:
            arquivo.unlink(missing_ok=True)


if __name__=='__main__':
    main()
