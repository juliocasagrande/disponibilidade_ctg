"""Projecao de disponibilidade por faixa de potencia SIN (Revisao Quinquenal 2028)."""
from datetime import date, datetime
from pathlib import Path

import duckdb
import openpyxl

from .caminhos import ARQUIVO_SIN_EXCEL, ARQUIVO_SIN_PARQUET, ARQUIVO_VALIDACAO_2022_PARQUET

FAIXAS_META = {
    1: ('≤ 29 MW', 29, 94.584, 1.684, 3.796),
    2: ('29–59 MW', 59, 94.582, 1.844, 3.641),
    3: ('59–199 MW', 199, 94.761, 1.591, 3.707),
    4: ('199–499 MW', 499, 93.934, 2.681, 3.478),
    5: ('499–1300 MW', 1300, 95.545, 2.107, 2.399),
}

CTG_POLO_FAIXA = {
    'UHE.PH.SP.001285-8.01': ('Polo Chavantes', 2),
    'UHE.PH.SP.000764-1.01': ('Polo Chavantes', 3),
    'UHE.PH.SP.002648-4.01': ('Polo Chavantes', 1),
    'UHE.PH.SP.027092-0.01': ('Polo Chavantes', 1),
    'UHE.PH.SP.000647-5.01': ('Polo Chavantes', 1),
    'UHE.PH.SP.000657-2.01': ('Polo Capivara', 3),
    'UHE.PH.SP.002821-5.01': ('Polo Capivara', 3),
    'UHE.PH.SP.002555-0.01': ('Polo Capivara', 3),
    'UHE.PH.SC.030415-8.01': ('Polo Capivara', 3),
    'UHE.PH.SP.001282-3.01': ('Polo Jupiá', 3),
    'UHE.PH.GO.028758-0.01': ('Polo Jupiá', 2),
    'UHE.PH.SP.001120-7.01': ('Polo Ilha Solteira', 3),
}


def _para_data(v):
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return None


def extrair_cadastro_sin(raiz):
    """Extrai o cadastro SIN (Configuracoes + Validacao 2022) para Parquets padronizados."""
    raiz = Path(raiz)
    excel = raiz / 'dados/referencias_sin' / ARQUIVO_SIN_EXCEL.name
    dest_sin = raiz / 'dados/referencias_sin' / ARQUIVO_SIN_PARQUET.name
    dest_val = raiz / 'dados/referencias_sin' / ARQUIVO_VALIDACAO_2022_PARQUET.name

    if not excel.is_file():
        return dest_sin.is_file()

    wb = openpyxl.load_workbook(excel, data_only=True)
    try:
        ws = wb['Configurações']
        linhas_sin = []
        # Linhas 15 a 180 correspondem exatamente ao intervalo de calculo do Painel 2028;
        # preservamos tambem a linha 181 (ITAIPU geral) sinalizada via no_painel_base.
        for r in range(15, ws.max_row + 1):
            sid = ws.cell(r, 2).value
            if not sid:
                continue
            linhas_sin.append((
                str(sid).strip(),
                str(ws.cell(r, 3).value or '').strip(),
                str(ws.cell(r, 4).value or '').strip(),
                str(ws.cell(r, 5).value or '').strip(),
                int(ws.cell(r, 6).value or 0),
                int(ws.cell(r, 7).value or 0),
                _para_data(ws.cell(r, 8).value),
                bool(int(ws.cell(r, 9).value or 0)),
                bool(int(ws.cell(r, 10).value or 0)),
                r <= 180,
            ))

        linhas_val = []
        if 'Validação 2022' in wb.sheetnames:
            wsv = wb['Validação 2022']
            for r in range(6, 11):
                faixa = int(wsv.cell(r, 2).value)
                linhas_val.append((
                    faixa,
                    FAIXAS_META[faixa][0],
                    int(wsv.cell(r, 3).value),
                    int(wsv.cell(r, 4).value),
                    int(wsv.cell(r, 5).value),
                    float(wsv.cell(r, 6).value),
                    float(wsv.cell(r, 7).value),
                    float(wsv.cell(r, 8).value),
                    float(wsv.cell(r, 9).value),
                    float(wsv.cell(r, 10).value),
                    float(wsv.cell(r, 11).value),
                    float(wsv.cell(r, 12).value),
                    str(wsv.cell(r, 13).value or ''),
                ))
    finally:
        wb.close()

    dest_sin.parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect() as c:
        c.execute('''
            CREATE TABLE sin_tmp (
                id_sin VARCHAR, usina_cadastro VARCHAR, usina_ons VARCHAR, cod_ceg VARCHAR,
                faixa INTEGER, ugs INTEGER, motorizacao DATE, incluida BOOLEAN,
                excluida BOOLEAN, no_painel_base BOOLEAN
            )
        ''')
        c.executemany('INSERT INTO sin_tmp VALUES (?,?,?,?,?,?,?,?,?,?)', linhas_sin)
        c.execute('COPY sin_tmp TO ? (FORMAT PARQUET, COMPRESSION ZSTD)', [str(dest_sin)])

        c.execute('''
            CREATE TABLE val_tmp (
                faixa INTEGER, faixa_label VARCHAR, teto_mw INTEGER,
                ugs_publ INTEGER, ugs_base INTEGER,
                teif_publ_pct DOUBLE, teif_calc_pct DOUBLE,
                ip_publ_pct DOUBLE, ip_calc_pct DOUBLE,
                id_publ_pct DOUBLE, id_calc_pct DOUBLE,
                delta_id_pp DOUBLE, resultado VARCHAR
            )
        ''')
        c.executemany('INSERT INTO val_tmp VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', linhas_val)
        c.execute('COPY val_tmp TO ? (FORMAT PARQUET, COMPRESSION ZSTD)', [str(dest_val)])
    return True


def calcular_projecao_sin(con, raiz):
    """Cria tabelas DuckDB de projecao 2028 por faixa SIN e comparacao com as 12 UHEs CTG."""
    raiz = Path(raiz)
    dest_sin = raiz / 'dados/referencias_sin' / ARQUIVO_SIN_PARQUET.name
    dest_val = raiz / 'dados/referencias_sin' / ARQUIVO_VALIDACAO_2022_PARQUET.name
    if not dest_sin.is_file() or not dest_val.is_file():
        extrair_cadastro_sin(raiz)

    # Tabela de metadados de faixa + polos CTG
    con.execute('''
        CREATE OR REPLACE TABLE dim_faixas_potencia (
            faixa INTEGER PRIMARY KEY,
            faixa_label VARCHAR,
            teto_mw INTEGER,
            id_ref_2022_pct DOUBLE,
            teif_ref_2022_pct DOUBLE,
            ip_ref_2022_pct DOUBLE
        )
    ''')
    con.executemany(
        'INSERT INTO dim_faixas_potencia VALUES (?,?,?,?,?,?)',
        [(k, v[0], v[1], v[2], v[3], v[4]) for k, v in FAIXAS_META.items()],
    )

    con.execute('''
        CREATE OR REPLACE TABLE dim_polo_faixa_ctg (
            cod_ceg VARCHAR PRIMARY KEY,
            polo VARCHAR,
            faixa INTEGER
        )
    ''')
    con.executemany(
        'INSERT INTO dim_polo_faixa_ctg VALUES (?,?,?)',
        [(ceg, pf[0], pf[1]) for ceg, pf in CTG_POLO_FAIXA.items()],
    )

    if dest_sin.is_file():
        con.execute('CREATE OR REPLACE TABLE cadastro_sin_faixas AS SELECT * FROM read_parquet(?)', [str(dest_sin)])
    else:
        con.execute('''
            CREATE OR REPLACE TABLE cadastro_sin_faixas (
                id_sin VARCHAR, usina_cadastro VARCHAR, usina_ons VARCHAR, cod_ceg VARCHAR,
                faixa INTEGER, ugs INTEGER, motorizacao DATE, incluida BOOLEAN,
                excluida BOOLEAN, no_painel_base BOOLEAN
            )
        ''')

    if dest_val.is_file():
        con.execute('CREATE OR REPLACE TABLE validacao_2022_faixas AS SELECT * FROM read_parquet(?)', [str(dest_val)])
    else:
        con.execute('''
            CREATE OR REPLACE TABLE validacao_2022_faixas AS
            SELECT faixa, faixa_label, teto_mw, 0 AS ugs_publ, 0 AS ugs_base,
                   teif_ref_2022_pct AS teif_publ_pct, teif_ref_2022_pct AS teif_calc_pct,
                   ip_ref_2022_pct AS ip_publ_pct, ip_ref_2022_pct AS ip_calc_pct,
                   id_ref_2022_pct AS id_publ_pct, id_ref_2022_pct AS id_calc_pct,
                   0.0 AS delta_id_pp, 'REPRODUZ' AS resultado
            FROM dim_faixas_potencia
        ''')

    # Ultimas taxas SIN (competencia mais recente publicada no TAXA_TEIF_TEIP.parquet)
    con.execute('''
        CREATE OR REPLACE TABLE sin_usinas_taxas_ultimas AS
        WITH competencia AS (
            SELECT max(din_mes::DATE) AS mes_ref_ons
            FROM read_parquet('dados/ons/taxas/TAXA_TEIF_TEIP.parquet')
        ),
        ult AS (
            SELECT trim(o.nom_usina) AS nom_usina,
                   trim(o.cod_ceg) AS cod_ceg,
                   o.din_mes::DATE AS mes_ons,
                   upper(trim(o.nom_taxa)) AS taxa,
                   o.val_taxa
            FROM read_parquet('dados/ons/taxas/TAXA_TEIF_TEIP.parquet') o
            CROSS JOIN competencia c
            WHERE o.din_mes::DATE = c.mes_ref_ons
            QUALIFY row_number() OVER (
                PARTITION BY trim(o.nom_usina), trim(o.cod_ceg), upper(trim(o.nom_taxa))
                ORDER BY o.num_versao DESC, o.din_calculo DESC
            ) = 1
        ),
        piv AS (
            SELECT nom_usina, cod_ceg, max(mes_ons) AS mes_ons,
                   max(val_taxa) FILTER (WHERE taxa = 'TEIFA') * 100.0 AS teifa_pct,
                   max(val_taxa) FILTER (WHERE taxa = 'TEIP') * 100.0 AS teip_pct
            FROM ult
            GROUP BY nom_usina, cod_ceg
        )
        SELECT s.id_sin, s.usina_cadastro, s.usina_ons, s.cod_ceg,
               s.faixa, s.ugs, s.motorizacao, s.incluida, s.excluida, s.no_painel_base,
               p.mes_ons, p.teifa_pct, p.teip_pct,
               (1.0 - p.teifa_pct/100.0) * (1.0 - p.teip_pct/100.0) * 100.0 AS id_atual_pct,
               (s.no_painel_base AND s.incluida AND NOT s.excluida
                AND s.faixa BETWEEN 1 AND 5 AND s.ugs > 0
                AND s.motorizacao IS NOT NULL
                AND s.motorizacao <= (p.mes_ons - INTERVAL '59 months')::DATE
                AND p.teifa_pct IS NOT NULL AND p.teip_pct IS NOT NULL) AS valida_calculo,
               EXISTS (SELECT 1 FROM dim_usinas_ctg d WHERE d.cod_ceg = s.cod_ceg) AS usina_ctg
        FROM cadastro_sin_faixas s
        LEFT JOIN piv p
          ON upper(trim(s.usina_ons)) = upper(p.nom_usina)
         AND s.cod_ceg = p.cod_ceg
    ''')

    # Consolidacao por faixa de potencia (metodologia Relatorio Revisao 4, secao 3.1)
    con.execute('''
        CREATE OR REPLACE TABLE projecao_faixas_sin AS
        WITH agg AS (
            SELECT faixa,
                   max(mes_ons) AS mes_ons,
                   sum(ugs) FILTER (WHERE valida_calculo) AS ugs_sin,
                   count(*) FILTER (WHERE valida_calculo) AS usinas_sin,
                   sum(ugs * teifa_pct) FILTER (WHERE valida_calculo)
                       / nullif(sum(ugs) FILTER (WHERE valida_calculo), 0) AS teifa_proj_pct,
                   sum(ugs * teip_pct) FILTER (WHERE valida_calculo)
                       / nullif(sum(ugs) FILTER (WHERE valida_calculo), 0) AS teip_proj_pct
            FROM sin_usinas_taxas_ultimas
            WHERE faixa BETWEEN 1 AND 5
            GROUP BY faixa
        )
        SELECT f.faixa, f.faixa_label, f.teto_mw,
               a.mes_ons,
               coalesce(a.ugs_sin, 0)::INTEGER AS ugs_sin,
               coalesce(a.usinas_sin, 0)::INTEGER AS usinas_sin,
               a.teifa_proj_pct,
               a.teip_proj_pct,
               100.0 * (1.0 - a.teifa_proj_pct/100.0) * (1.0 - a.teip_proj_pct/100.0) AS id_proj_2028_pct,
               f.id_ref_2022_pct,
               f.teif_ref_2022_pct,
               f.ip_ref_2022_pct,
               100.0 * (1.0 - a.teifa_proj_pct/100.0) * (1.0 - a.teip_proj_pct/100.0) - f.id_ref_2022_pct AS delta_2028_2022_pp
        FROM dim_faixas_potencia f
        LEFT JOIN agg a USING (faixa)
        ORDER BY f.faixa
    ''')

    # Analise das 12 UHEs CTG comparando ID atual 60m vs Ref MME 2022 vs Projecao Faixa 2028
    con.execute('''
        CREATE OR REPLACE TABLE analise_ctg_faixas AS
        WITH ultimo AS (
            SELECT *
            FROM indicadores_disponibilidade_ctg
            WHERE mes_fim_historico = (SELECT max(mes_fim_historico) FROM indicadores_disponibilidade_ctg)
        )
        SELECT u.cod_ceg, u.usina, pf.polo, pf.faixa,
               f.faixa_label,
               d.quantidade_ugs_escopo AS qtde_ugs,
               u.mes_fim_historico,
               u.teifa_pct, u.teip_pct, u.id_verificado_pct,
               u.id_referencia * 100.0 AS id_ref_mme_pct,
               u.fid_bruto, u.fid_mra,
               f.id_proj_2028_pct AS id_faixa_2028_pct,
               u.id_verificado_pct - f.id_proj_2028_pct AS delta_vs_faixa_2028_pp,
               u.id_verificado / nullif(f.id_proj_2028_pct / 100.0, 0) AS fid_bruto_faixa_2028,
               least(1.0, u.id_verificado / nullif(f.id_proj_2028_pct / 100.0, 0)) AS fid_mra_faixa_2028
        FROM ultimo u
        JOIN dim_usinas_ctg d USING (cod_ceg)
        JOIN dim_polo_faixa_ctg pf USING (cod_ceg)
        LEFT JOIN projecao_faixas_sin f ON f.faixa = pf.faixa
        ORDER BY pf.polo, u.usina
    ''')
