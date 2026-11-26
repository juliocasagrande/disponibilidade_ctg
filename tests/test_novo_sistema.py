"""Testes das novas funcionalidades: manutencoes programadas, projecao 2028 SIN e API Admin."""
import calendar
from datetime import date
from functools import partial
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest

import duckdb

from scripts.app import admin as admin_mod
from scripts.app.caminhos import caminho_tabela
from scripts.app.manutencoes import (
    CLASSIFICADORES_ONS,
    agregar_manutencoes_mensal,
    avaliar_expurgo_evento,
    calcular_auditoria_franquias,
)
from scripts.app.painel import ServidorPainel

RAIZ = Path(__file__).resolve().parents[1]
PASTA = RAIZ / 'resultados'


class ManutencoesTest(unittest.TestCase):
    def test_rateio_virada_de_mes_e_sobreposicao(self):
        eventos = [
            {
                'cod_ceg': 'UHE.PH.SP.000647-5.01', 'usina': 'Canoas I', 'numero_ug': 1,
                'data_inicio': date(2027, 1, 30), 'data_fim': date(2027, 2, 2),
                'indisponibilidade_horas': 96.0, 'expurgo_horas': 0.0,
                'tipo_manut': 'MPP0', 'descricao_breve': 'MPP0', 'ativa_para_calculo': True,
            },
            {
                # Evento sobreposto no mesmo dia (31/01) nao deve duplicar para 48h/dia
                'cod_ceg': 'UHE.PH.SP.000647-5.01', 'usina': 'Canoas I', 'numero_ug': 1,
                'data_inicio': date(2027, 1, 31), 'data_fim': date(2027, 1, 31),
                'indisponibilidade_horas': 24.0, 'expurgo_horas': 0.0,
                'tipo_manut': 'MPAIE', 'descricao_breve': 'Coletor', 'ativa_para_calculo': True,
            },
            {
                # Evento cancelado / inativo ignorado
                'cod_ceg': 'UHE.PH.SP.000647-5.01', 'usina': 'Canoas I', 'numero_ug': 1,
                'data_inicio': date(2027, 3, 1), 'data_fim': date(2027, 3, 5),
                'indisponibilidade_horas': 120.0, 'expurgo_horas': 0.0,
                'tipo_manut': 'MOD', 'descricao_breve': 'Cancelado', 'ativa_para_calculo': False,
            },
        ]
        mensal = agregar_manutencoes_mensal(eventos)
        self.assertEqual(len(mensal), 2)
        jan, fev = mensal
        self.assertEqual(jan['mes'], date(2027, 1, 1))
        self.assertEqual(jan['hdp_programado'], 48.0)  # 2 dias * 24h (sem duplicacao)
        self.assertEqual(fev['mes'], date(2027, 2, 1))
        self.assertEqual(fev['hdp_programado'], 48.0)  # 2 dias * 24h

    def test_parquet_manutencoes_respeita_limite_hp(self):
        arq = caminho_tabela('manutencoes_ug_mensal', PASTA)
        self.assertTrue(arq.is_file())
        with duckdb.connect() as con:
            linhas = con.execute(
                'SELECT mes, hdp_programado, hrd_expurgado, hdce_expurgado, horas_brutas FROM read_parquet(?)',
                [str(arq)],
            ).fetchall()
        self.assertGreater(len(linhas), 500)
        for mes_dt, hdp, hrd, hdce, bruto in linhas:
            hp = calendar.monthrange(mes_dt.year, mes_dt.month)[1] * 24
            self.assertGreaterEqual(hdp, 0.0)
            self.assertGreaterEqual(hrd, 0.0)
            self.assertGreaterEqual(hdce, 0.0)
            self.assertLessEqual(hdp + hrd + hdce, hp + 1e-4)
            self.assertAlmostEqual(bruto, hdp + hrd + hdce, places=3)

    def test_classificadores_ons_e_expurgo_automatico(self):
        codigos = {c['codigo'] for c in CLASSIFICADORES_ONS}
        self.assertEqual(
            codigos,
            {'GUM', 'GAC', 'GRH', 'GCB', 'GCC', 'GIS', 'GIM', 'GMT', 'GIC', 'GCI', 'GRE', 'GHN', 'GRB'},
        )
        # GIS sem expurgo na planilha -> expurgo automatico 100% para HRD
        r_gis = avaliar_expurgo_evento('GIS', 48.0, 0.0, True)
        self.assertEqual(r_gis['expurgo_horas'], 48.0)
        self.assertEqual(r_gis['indisponibilidade_horas'], 0.0)
        self.assertEqual(r_gis['expurgo_origem'], 'CLASSIFICADOR_ONS')
        self.assertEqual(r_gis['destino_ons'], 'HRD')

        # GRE (queda util, externa 7.1.3.3) -> expurgo 100% para HDCE
        r_gre = avaliar_expurgo_evento('GRE', 72.0, 0.0, True)
        self.assertEqual(r_gre['expurgo_horas'], 72.0)
        self.assertEqual(r_gre['indisponibilidade_horas'], 0.0)
        self.assertEqual(r_gre['destino_ons'], 'HDCE')

        # GIS com expurgo parcial explicito (ex.: Black Start 8h em dia de 24h) -> respeita 8h
        r_bs = avaliar_expurgo_evento('GIS', 24.0, 8.0, True)
        self.assertEqual(r_bs['expurgo_horas'], 8.0)
        self.assertEqual(r_bs['indisponibilidade_horas'], 16.0)
        self.assertEqual(r_bs['expurgo_origem'], 'PLANILHA')
        self.assertEqual(r_bs['destino_ons'], 'HRD + HDP')

        # Expurgo maior que bruto (ex.: GAR UG01 R202) -> clampado, nunca gera indisponibilidade negativa
        r_clamp = avaliar_expurgo_evento('GIM', 792.0, 912.0, True)
        self.assertEqual(r_clamp['expurgo_horas'], 792.0)
        self.assertEqual(r_clamp['indisponibilidade_horas'], 0.0)

        # GUM sem expurgo -> 100% HDP
        r_gum = avaliar_expurgo_evento('GUM', 120.0, 0.0, True)
        self.assertEqual(r_gum['expurgo_horas'], 0.0)
        self.assertEqual(r_gum['indisponibilidade_horas'], 120.0)
        self.assertEqual(r_gum['destino_ons'], 'HDP')

    def test_consumo_cronologico_gim_e_precedencia_sobreposicao(self):
        # Evento GIM de 40 dias (Jan 1..Fev 9 = 960h) com 744h de expurgo (31 dias = Jan inteiro)
        # + evento GUM sobreposto em Jan 10..12: pela regra 5.2.7, HRD prevalece sobre GUM em Jan!
        eventos = [
            {
                'cod_ceg': 'UHE.PH.SP.001282-3.01', 'usina': 'Jupia', 'numero_ug': 9,
                'data_inicio': date(2027, 1, 1), 'data_fim': date(2027, 2, 9),
                'horas_brutas': 960.0, 'expurgo_horas': 744.0, 'indisponibilidade_horas': 216.0,
                'classificador': 'GIM', 'destino_expurgo': 'HRD', 'tipo_manut': 'MOD',
                'descricao_breve': 'Modernizacao', 'ativa_no_plano': True, 'ativa_para_calculo': True,
            },
            {
                'cod_ceg': 'UHE.PH.SP.001282-3.01', 'usina': 'Jupia', 'numero_ug': 9,
                'data_inicio': date(2027, 1, 10), 'data_fim': date(2027, 1, 12),
                'horas_brutas': 72.0, 'expurgo_horas': 0.0, 'indisponibilidade_horas': 72.0,
                'classificador': 'GUM', 'destino_expurgo': '', 'tipo_manut': 'MPAIE',
                'descricao_breve': 'Inspecao', 'ativa_no_plano': True, 'ativa_para_calculo': True,
            },
        ]
        mensal = agregar_manutencoes_mensal(eventos)
        self.assertEqual(len(mensal), 2)
        jan, fev = mensal
        # Janeiro: 100% HRD (744h), 0h HDP (mesmo com GUM sobreposto)
        self.assertEqual(jan['hrd_expurgado'], 744.0)
        self.assertEqual(jan['hdp_programado'], 0.0)
        # Fevereiro: 9 dias excedentes = 216h HDP, 0h HRD
        self.assertEqual(fev['hrd_expurgado'], 0.0)
        self.assertEqual(fev['hdp_programado'], 216.0)

    def test_cronologico_real_jupia_ug9_e_auditoria_franquias(self):
        arq_m = caminho_tabela('manutencoes_ug_mensal', PASTA)
        arq_f = caminho_tabela('auditoria_franquias_ons', PASTA)
        self.assertTrue(arq_f.is_file())
        with duckdb.connect() as con:
            # Jupia UG 9 em Nov/2026: franquia GIM (8.631h) ja se esgotou em Jul/2026 -> 720h HDP em Nov/2026!
            jup_nov = con.execute(
                "SELECT hdp_programado, hrd_expurgado FROM read_parquet(?) "
                "WHERE usina='Jupia' AND numero_ug=9 AND mes=DATE '2026-11-01'",
                [str(arq_m)],
            ).fetchone()
            self.assertIsNotNone(jup_nov)
            self.assertAlmostEqual(jup_nov[0], 720.0, places=1)
            self.assertAlmostEqual(jup_nov[1], 0.0, places=1)

            # Ilha Solteira UG 2 em Nov/2026: ainda dentro da franquia GIM (8.232h) -> 720h HRD, 0h HDP!
            ils_nov = con.execute(
                "SELECT hdp_programado, hrd_expurgado FROM read_parquet(?) "
                "WHERE usina='Ilha Solteira' AND numero_ug=2 AND mes=DATE '2026-11-01'",
                [str(arq_m)],
            ).fetchone()
            self.assertIsNotNone(ils_nov)
            self.assertAlmostEqual(ils_nov[0], 0.0, places=1)
            self.assertAlmostEqual(ils_nov[1], 720.0, places=1)

            # Auditoria de franquias identifica GIM e GMT
            fr_stats = con.execute(
                "SELECT count(*), count(*) FILTER (WHERE status='EXCEDIDO') FROM read_parquet(?)",
                [str(arq_f)],
            ).fetchone()
            self.assertGreater(fr_stats[0], 20)
            self.assertGreater(fr_stats[1], 0)


class ProjecaoSinTest(unittest.TestCase):
    def test_cinco_faixas_e_doze_usinas_ctg(self):
        with duckdb.connect() as con:
            faixas = con.execute(
                'SELECT faixa, ugs_sin, usinas_sin, id_proj_2028_pct FROM read_parquet(?) ORDER BY faixa',
                [str(caminho_tabela('projecao_faixas_sin', PASTA))],
            ).fetchall()
            ctg = con.execute(
                'SELECT count(*), count(DISTINCT polo) FROM read_parquet(?)',
                [str(caminho_tabela('analise_ctg_faixas', PASTA))],
            ).fetchone()
        self.assertEqual(len(faixas), 5)
        for faixa, ugs, usinas, id_pct in faixas:
            self.assertGreater(ugs, 0)
            self.assertGreater(usinas, 0)
            self.assertTrue(80.0 < id_pct <= 100.0, (faixa, id_pct))
        self.assertEqual(ctg, (12, 4))

    def test_autosuficiente_sem_referencias_sin_e_itaipu_vinculada(self):
        import shutil
        import tempfile
        from scripts.app.projecao_sin import calcular_projecao_sin

        with tempfile.TemporaryDirectory() as tmp:
            raiz_tmp = Path(tmp)
            for rel in ('dados/ons/cadastro/CAPACIDADE_GERACAO.parquet', 'dados/ons/taxas/TAXA_TEIF_TEIP.parquet'):
                destino = raiz_tmp / rel
                destino.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(RAIZ / rel, destino)

            # Sem nenhum arquivo em dados/referencias_sin/, o calculo deriva tudo do ONS
            self.assertFalse((raiz_tmp / 'dados/referencias_sin').exists())

            with duckdb.connect() as con:
                con.execute("CREATE TABLE dim_usinas_ctg (cod_ceg VARCHAR, quantidade_ugs_escopo INTEGER)")
                con.execute('''
                    CREATE TABLE indicadores_disponibilidade_ctg (
                        cod_ceg VARCHAR, usina VARCHAR, mes_fim_historico DATE,
                        teifa_pct DOUBLE, teip_pct DOUBLE, id_verificado DOUBLE,
                        id_verificado_pct DOUBLE, id_referencia DOUBLE,
                        fid_bruto DOUBLE, fid_mra DOUBLE
                    )
                ''')
                calcular_projecao_sin(con, raiz_tmp)
                faixas = con.execute(
                    'SELECT faixa, ugs_sin, usinas_sin, id_proj_2028_pct FROM projecao_faixas_sin ORDER BY faixa'
                ).fetchall()
                val22 = con.execute('SELECT count(*) FROM validacao_2022_faixas').fetchone()[0]
                especiais = dict(con.execute('''
                    SELECT id_sin, (faixa, ugs, valida_calculo, teifa_pct IS NOT NULL AND teip_pct IS NOT NULL)
                    FROM sin_usinas_taxas_ultimas
                    WHERE id_sin IN ('SIN76', 'TAX165', 'SIN83-GERAL')
                ''').fetchall())

        self.assertEqual([(f, ugs, us) for f, ugs, us, _ in faixas], [
            (1, 68, 24),
            (2, 117, 38),
            (3, 349, 60),
            (4, 101, 19),
            (5, 44, 3),
        ])
        self.assertEqual(val22, 5)
        self.assertEqual(especiais['SIN76'], (5, 18, True, True))
        self.assertEqual(especiais['TAX165'], (2, 6, True, True))
        self.assertEqual(especiais['SIN83-GERAL'], (5, 20, True, True))

    def test_historico_sin_data_de_corte_e_nome_pagina(self):
        from scripts.app.caminhos import BANCO_PADRAO, HTML_PAINEL
        from scripts.app.painel import coletar_dados_painel

        with duckdb.connect(str(RAIZ / BANCO_PADRAO), read_only=True) as con:
            dados = coletar_dados_painel(con)
        self.assertIn('2025-12', dados['sin_meses'])
        self.assertIn('2025-12', dados['sin_taxas_hist'])
        self.assertGreater(len(dados['sin_meses']), 12)
        self.assertGreater(len(dados['sin_taxas_hist']['2025-12']), 100)

        html = (RAIZ / HTML_PAINEL).read_text(encoding='utf-8')
        self.assertIn('Projeção ID Ref', html)
        self.assertIn('id="proj-mes-corte"', html)

    def test_auto_update_desativavel(self):
        self.assertIsNone(admin_mod.iniciar_atualizacao_automatica(RAIZ, intervalo_horas=0))


class AdminApiTest(unittest.TestCase):
    def setUp(self):
        self.servidor = ThreadingHTTPServer(('127.0.0.1', 0), partial(ServidorPainel, raiz=RAIZ))
        self.porta = self.servidor.server_port
        self.thread = threading.Thread(target=self.servidor.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.servidor.shutdown()
        self.servidor.server_close()

    def req(self, method, path, body=None, cookie=None):
        conn = HTTPConnection('127.0.0.1', self.porta, timeout=10)
        headers = {'Host': f'127.0.0.1:{self.porta}'}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        if cookie:
            headers['Cookie'] = cookie
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        sc = resp.getheader('Set-Cookie')
        conn.close()
        return resp.status, raw, sc

    def test_protecao_autenticacao_parquet_e_sql_somente_leitura(self):
        # 1) Sem login -> 401
        st, _, _ = self.req('GET', '/api/admin/parquets')
        self.assertEqual(st, 401)

        # 2) Senha invalida -> 401
        st, _, _ = self.req('POST', '/api/admin/login', {'senha': 'errada'})
        self.assertEqual(st, 401)

        # 3) Login valido -> 200 com cookie
        st, raw, sc = self.req('POST', '/api/admin/login', {'senha': admin_mod.SENHA_PADRAO_ADMIN})
        self.assertEqual(st, 200)
        self.assertIsNotNone(sc)
        cookie = sc.split(';', 1)[0]

        # 4) Listar e visualizar Parquet
        st, raw, _ = self.req('GET', '/api/admin/parquets', cookie=cookie)
        self.assertEqual(st, 200)
        arquivos = json.loads(raw)['arquivos']
        self.assertGreater(len(arquivos), 10)

        st, raw, _ = self.req(
            'GET',
            '/api/admin/parquet/preview?caminho=resultados/consolidadas/projecao_faixas_sin.parquet&limite=10',
            cookie=cookie,
        )
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)['total_linhas'], 5)

        # 5) Path traversal bloqueado
        st, _, _ = self.req('GET', '/api/admin/parquet/preview?caminho=../README.md', cookie=cookie)
        self.assertEqual(st, 400)

        # 6) SQL somente leitura funciona e bloqueia escrita
        st, raw, _ = self.req(
            'POST', '/api/admin/sql', {'sql': 'SELECT count(*) AS n FROM dim_usinas_ctg'}, cookie=cookie
        )
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)['linhas'][0][0], 12)

        st, _, _ = self.req('POST', '/api/admin/sql', {'sql': 'DROP TABLE dim_usinas_ctg'}, cookie=cookie)
        self.assertEqual(st, 400)

    def test_pwa_manifest_service_worker_icones_e_bundle_mobile(self):
        from scripts.app.mobile import exportar_bundle_mobile

        st, raw, _ = self.req('GET', '/manifest.webmanifest')
        self.assertEqual(st, 200)
        manifest = json.loads(raw)
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual(manifest['theme_color'], '#051d33')

        st, raw, _ = self.req('GET', '/sw.js')
        self.assertEqual(st, 200)
        self.assertIn(b'CACHE_NAME', raw)

        st, raw, _ = self.req('GET', '/icons/icon-192.png')
        self.assertEqual(st, 200)
        self.assertTrue(raw.startswith(b'\x89PNG'))

        destino = exportar_bundle_mobile(RAIZ)
        self.assertTrue(destino.is_file())
        html = destino.read_text(encoding='utf-8')
        self.assertIn('mob-bottom-nav', html)
        self.assertIn('mob-filter-strip', html)
        self.assertIn('native-bridge.js', html)


if __name__ == '__main__':
    unittest.main()
