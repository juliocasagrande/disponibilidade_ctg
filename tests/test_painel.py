"""Testes da projecao SQL e dos produtos Parquet gerados."""
from datetime import date
from pathlib import Path
import unittest

import duckdb

from scripts.app.caminhos import caminho_tabela
from scripts.app.painel import preparar_cenario, somar_meses


RAIZ = Path(__file__).resolve().parents[1]
PASTA = RAIZ/'resultados'
CEG = 'UHE.PH.SP.000647-5.01'


class PainelTest(unittest.TestCase):
    def calcular(self, horizonte=12, alteracoes=None, referencia=None):
        con = duckdb.connect()
        self.addCleanup(con.close)
        entrada = dict(cod_ceg=CEG,horizonte=horizonte,alteracoes=alteracoes or [])
        if referencia is not None:
            entrada['id_referencia'] = referencia
        preparar_cenario(con,PASTA,entrada)
        return con

    def test_parquet_largo_cobre_68_ugs_em_todos_os_meses(self):
        with duckdb.connect() as con:
            quantidade = con.execute("SELECT count(*),count(DISTINCT cod_ceg),count(DISTINCT (cod_ceg,ug)),count(DISTINCT data) "
                                     "FROM read_parquet(?)",[str(caminho_tabela('horas_ug_mensal_ctg',PASTA))]).fetchone()
            self.assertEqual(quantidade[:3],(68*quantidade[3],12,68))
            colunas = [r[0] for r in con.execute('DESCRIBE SELECT * FROM read_parquet(?)',
                       [str(caminho_tabela('horas_ug_mensal_ctg',PASTA))]).fetchall()]
            self.assertTrue({'data','nome_usina','ug','potencia_ug_mw','HDP','HDF','HEDP','HEDF','HS','HRD','HDCE','HP'} <= set(colunas))

    def test_referencias_sao_por_usina(self):
        with duckdb.connect() as con:
            ref = con.execute("SELECT teif_referencia,ip_referencia,inicio_vigencia FROM read_parquet(?) WHERE usina='Jupia'",
                              [str(caminho_tabela('referencias_fid_ctg',PASTA))]).fetchone()
            self.assertAlmostEqual(ref[0],0.03190)
            self.assertAlmostEqual(ref[1],0.05923)
            self.assertEqual(ref[2],date(2023,1,1))

    def test_janela_exclui_mes_mais_antigo(self):
        con = self.calcular(1)
        fim,inicio,excluido,ref,validos = con.execute('''SELECT mes_fim_historico,mes_inicio_historico,
            mes_excluido,mes_referencia_contabil,meses_validos FROM resultado_cenario''').fetchone()
        base = con.execute('SELECT mes_base FROM configuracao').fetchone()[0]
        self.assertEqual((fim,inicio,excluido,ref,validos),
                         (somar_meses(base,1),somar_meses(base,-58),somar_meses(base,-59),somar_meses(base,2),60))
        # Independente da funcao janela: soma explicitamente os 59 meses retidos.
        nf,df,np,dp = con.execute('''SELECT sum(numerador_teifa),sum(denominador_teifa),
            sum(numerador_teip),sum(denominador_teip) FROM historico
            WHERE cod_ceg=? AND mes BETWEEN ? AND ?''',[CEG,inicio,base]).fetchone()
        capacidade_horas = con.execute('SELECT sum(potencia_ug_mw*HP) FROM cenario_horas').fetchone()[0]
        f,p = con.execute('SELECT teifa,teip FROM resultado_cenario').fetchone()
        self.assertAlmostEqual(f,nf/(df+capacidade_horas))
        self.assertAlmostEqual(p,np/(dp+capacidade_horas))

    def test_depois_de_60_meses_nao_resta_historico_real(self):
        con = self.calcular(61)
        ultimo = con.execute('SELECT teifa,teip,id_verificado,fid_bruto,fid_mra FROM resultado_cenario '
                             'ORDER BY mes_fim_historico DESC LIMIT 1').fetchone()
        self.assertEqual(ultimo[:3],(0.0,0.0,1.0))
        self.assertGreater(ultimo[3],1.0)
        self.assertEqual(ultimo[4],1.0)

    def test_manutencao_reduz_disponibilidade_e_fid(self):
        con0 = self.calcular(1)
        mes = str(con0.execute('SELECT mes_fim_historico FROM resultado_cenario').fetchone()[0])[:7]
        con = self.calcular(1,[dict(mes=mes,ug=1,HDP=100,HDF=20)])
        id0,fid0 = con0.execute('SELECT id_verificado,fid_bruto FROM resultado_cenario').fetchone()
        id1,fid1 = con.execute('SELECT id_verificado,fid_bruto FROM resultado_cenario').fetchone()
        self.assertLess(id1,id0)
        self.assertLess(fid1,fid0)

    def test_rejeita_horas_invalidas_e_ugs_fora_do_escopo(self):
        base = self.calcular(1).execute('SELECT mes_base FROM configuracao').fetchone()[0]
        mes = str(somar_meses(base,1))[:7]
        for alteracao in [dict(mes=mes,ug=1,HDP=1000),dict(mes=mes,ug=1,HDF=-1),
                          dict(mes=mes,ug=99,HDP=2),dict(mes=mes,ug=1,HDF=float('nan')),
                          dict(mes='2020-01',ug=1,HDP=2)]:
            with self.subTest(alteracao=alteracao), self.assertRaises(ValueError):
                self.calcular(1,[alteracao])


if __name__=='__main__':
    unittest.main()
