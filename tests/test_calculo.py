"""Verifica regras de negocio com dados sinteticos, sem acesso a rede."""
import calendar
from datetime import date
from pathlib import Path
import unittest

import duckdb


RAIZ = Path(__file__).resolve().parents[1]
FONTES = (RAIZ / 'scripts/sql/01_fontes.sql').read_text(encoding='utf-8')
CALCULO = (RAIZ / 'scripts/sql/02_calculo.sql').read_text(encoding='utf-8')
CEG = 'UHE.PH.SP.000764-1.01'


class CalculoTest(unittest.TestCase):
    def setUp(self):
        self.con = duckdb.connect()
        # O teste deve ser executado na raiz, como os scripts SQL.
        self.con.execute(FONTES)
        self.con.execute("DELETE FROM cadastro_ugs_ctg WHERE cod_ceg<>? OR numero_ug>2", [CEG])
        self.con.execute('UPDATE cadastro_ugs_ctg SET quantidade_ugs_escopo=2, '
                         'potencia_mw=CASE WHEN numero_ug=1 THEN 100 ELSE 300 END')
        self.con.execute('DELETE FROM parametros_ctg_brutos')

    def tearDown(self):
        self.con.close()

    def semear(self, meses=1, hdf=(20, 40), hdp=(10, 30)):
        linhas = []
        for n in range(meses):
            ano, m = 2021 + n//12, 1 + n % 12
            mes = date(ano, m, 1)
            hp = 24*calendar.monthrange(ano, m)[1]
            for ug in (1, 2):
                horas = dict(HDF=hdf[ug-1], HEDF=0, HDP=hdp[ug-1], HEDP=0,
                             HP=hp, HS=hp-hdf[ug-1]-hdp[ug-1], HRD=0, HDCE=0)
                for insumo, valor in horas.items():
                    linhas.append((CEG, 'Chavantes', True, f'UG {ug}', ug,
                                   mes, insumo, valor, 1, 'sintetico'))
        self.con.executemany('INSERT INTO parametros_ctg_brutos VALUES (?,?,?,?,?,?,?,?,?,?)', linhas)

    def calcular(self):
        # Reusa a mesma selecao de versoes, deduplicacao e pivot do SQL entregue.
        self.con.execute(FONTES[FONTES.index('CREATE OR REPLACE TABLE parametros_ctg_revisados AS'):])
        self.con.execute(CALCULO)

    def ultimo(self):
        return self.con.execute('SELECT teifa,teip,meses_validos FROM taxas_60_meses_ctg '
                                'ORDER BY mes_fim_historico DESC LIMIT 1').fetchone()

    def test_potencia_pondera_usina(self):
        self.semear()
        self.calcular()
        f, p = self.con.execute('SELECT teifa,teip FROM taxas_mensais_ctg').fetchone()
        self.assertAlmostEqual(f, (100*20+300*40)/(100*734+300*714))
        self.assertAlmostEqual(p, (100*10+300*30)/(400*744))

    def test_janela_60_meses_e_referencia_seguinte(self):
        self.semear(60)
        self.calcular()
        self.assertEqual(self.ultimo()[2], 60)
        datas = self.con.execute('SELECT mes_inicio_historico,mes_fim_historico,'
                                'mes_referencia_contabil FROM taxas_60_meses_ctg '
                                'ORDER BY mes_fim_historico DESC LIMIT 1').fetchone()
        self.assertEqual(datas, (date(2021,1,1), date(2025,12,1), date(2026,1,1)))
        self.assertEqual(self.con.execute('SELECT count(*) FROM taxas_60_meses_ctg '
                                         'WHERE teifa IS NOT NULL').fetchone()[0], 1)

    def test_lacuna_nao_puxa_mes_mais_antigo(self):
        self.semear(61)
        self.con.execute("DELETE FROM parametros_ctg_brutos WHERE mes=DATE '2023-05-01'")
        self.calcular()
        self.assertEqual(self.ultimo(), (None, None, 59))

    def test_ug_ausente_invalida_usina(self):
        self.semear(60)
        self.con.execute("DELETE FROM parametros_ctg_brutos WHERE mes=DATE '2023-05-01' AND numero_ug=2")
        self.calcular()
        self.assertEqual(self.ultimo(), (None, None, 59))

    def test_revisao_so_de_uma_ug_preserva_demais(self):
        self.semear()
        self.con.execute('INSERT INTO parametros_ctg_brutos SELECT * REPLACE '
                         '(2 AS versao) FROM parametros_ctg_brutos WHERE numero_ug=1')
        self.calcular()
        self.assertEqual(self.con.execute('SELECT count(*) FROM horas_ug_mensal').fetchone()[0], 2)
        self.assertTrue(self.con.execute('SELECT mes_valido FROM taxas_mensais_ctg').fetchone()[0])

    def test_duplicata_identica_nao_soma_horas(self):
        self.semear()
        self.con.execute("INSERT INTO parametros_ctg_brutos SELECT * FROM parametros_ctg_brutos WHERE insumo='HP'")
        self.calcular()
        self.assertEqual(self.con.execute('SELECT sum(hp) FROM horas_ug_mensal').fetchone()[0], 1488)

    def test_duplicata_conflitante_invalida(self):
        self.semear()
        self.con.execute("INSERT INTO parametros_ctg_brutos SELECT * REPLACE (valor+1 AS valor) "
                         "FROM parametros_ctg_brutos WHERE insumo='HP' AND numero_ug=1")
        self.calcular()
        self.assertEqual(self.con.execute('SELECT teifa,teip FROM taxas_mensais_ctg').fetchone(), (None,None))

    def test_referencia_preenche_mes_ausente_em_horas(self):
        self.semear(60)
        self.con.execute("DELETE FROM parametros_ctg_brutos WHERE mes=DATE '2023-05-01'")
        for ug in (1,2):
            self.con.execute("INSERT INTO referencia_ug_mensal VALUES (?,?,DATE '2023-05-01',0.02,0.1,'referencia teste')", [CEG,ug])
        self.calcular()
        self.assertEqual(self.ultimo()[2], 60)
        nf, df, np, dp = self.con.execute("SELECT numerador_teifa,denominador_teifa,numerador_teip,denominador_teip "
                                        "FROM parcelas_ug_mensal WHERE mes=DATE '2023-05-01' AND numero_ug=1").fetchone()
        self.assertAlmostEqual(nf, 100*744*0.02*0.9)
        self.assertAlmostEqual(df, 100*744*0.9)
        self.assertAlmostEqual(np, 100*744*0.1)
        self.assertAlmostEqual(dp, 100*744)

    def test_denominador_zero_nao_vira_zero_porcento(self):
        self.semear(hdf=(0,0),hdp=(744,744))
        self.calcular()
        self.assertEqual(self.con.execute('SELECT teifa,teip FROM taxas_mensais_ctg').fetchone(), (None,1.0))

    def test_fechamento_divergente_sem_ressalva_invalida(self):
        self.semear()
        self.con.execute("UPDATE parametros_ctg_brutos SET valor=valor-10 WHERE insumo='HS' AND numero_ug=1")
        self.calcular()
        self.assertEqual(self.con.execute('SELECT teifa,teip FROM taxas_mensais_ctg').fetchone(), (None,None))
        self.assertEqual(self.con.execute('SELECT count(*) FROM auditoria_fechamento_horas '
                                         'WHERE NOT ressalva_fechamento AND NOT valido').fetchone()[0],1)


class RessalvaIlhaSolteiraTest(unittest.TestCase):
    def setUp(self):
        self.con = duckdb.connect()
        self.addCleanup(self.con.close)
        self.con.execute(FONTES)
        self.con.execute(CALCULO)

    def test_fonte_preservada_e_janelas_conciliadas(self):
        qualidade = self.con.execute("SELECT count(*),sum(saldo_horas),bool_and(NOT horas_validas "
            "AND ressalva_fechamento AND valido) FROM auditoria_fechamento_horas "
            "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes=DATE '2021-05-01'").fetchone()
        self.assertEqual(qualidade[0],13)
        self.assertAlmostEqual(qualidade[1],4638.9)
        self.assertTrue(qualidade[2])
        ug9 = self.con.execute("SELECT hp,hs,hrd,hdce,hdf,hdp FROM parcelas_ug_mensal "
            "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes=DATE '2021-05-01' AND numero_ug=9").fetchone()
        self.assertEqual(ug9,(744,0,0,0,0,0))
        janelas = self.con.execute("SELECT count(*),bool_and(status='OK' AND meses_validos=60 "
            "AND meses_com_ressalva=1) FROM conciliacao_ons WHERE cod_ceg='UHE.PH.SP.001120-7.01' "
            "AND mes_fim_historico BETWEEN DATE '2024-12-01' AND DATE '2026-04-01'").fetchone()
        self.assertEqual(janelas,(34,True))
        self.assertEqual(self.con.execute("SELECT meses_com_ressalva FROM taxas_60_meses "
            "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes_fim_historico=DATE '2026-05-01'").fetchone()[0],0)

    def test_ressalva_nao_aceita_parametros_alterados(self):
        self.con.execute("UPDATE horas_ug_mensal SET hs=hs+1 WHERE cod_ceg='UHE.PH.SP.001120-7.01' "
                         "AND mes=DATE '2021-05-01' AND numero_ug=5")
        self.con.execute(CALCULO)
        self.assertEqual(self.con.execute("SELECT horas_validas,ressalva_fechamento,valido "
            "FROM parcelas_ug_mensal WHERE cod_ceg='UHE.PH.SP.001120-7.01' "
            "AND mes=DATE '2021-05-01' AND numero_ug=5").fetchone(),(False,False,False))
        self.assertFalse(self.con.execute("SELECT mes_valido FROM taxas_mensais "
            "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes=DATE '2021-05-01'").fetchone()[0])

    def test_ressalva_nao_aceita_insumo_invalido(self):
        self.con.execute("UPDATE horas_ug_mensal SET parametros_validos=false "
                         "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes=DATE '2021-05-01' AND numero_ug=5")
        self.con.execute(CALCULO)
        self.assertEqual(self.con.execute("SELECT ressalva_fechamento,valido FROM parcelas_ug_mensal "
            "WHERE cod_ceg='UHE.PH.SP.001120-7.01' AND mes=DATE '2021-05-01' AND numero_ug=5").fetchone(),(False,False))


if __name__ == '__main__':
    unittest.main()
