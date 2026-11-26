"""Projecao de disponibilidade por faixa de potencia SIN (Revisao Quinquenal 2028).

Deriva o universo hidreletrico do SIN diretamente das bases oficiais do ONS
(CAPACIDADE_GERACAO.parquet e TAXA_TEIF_TEIP.parquet), seguindo a metodologia do
Relatorio MME/EPE/ONS/ANEEL "Revisao dos Valores de Referencia de TEIF e IP -
Revisao 4" (fev/2022, secao 3.1, pags. 9-10), sem depender de planilhas externas.
"""
from datetime import date, datetime
from pathlib import Path

import duckdb

from .caminhos import ARQUIVO_SIN_PARQUET, ARQUIVO_VALIDACAO_2022_PARQUET

# Faixas oficiais de potencia unitaria (MW/UG) e valores publicados em 2022
# (faixa: (rotulo, teto_mw, id_ref_2022_pct, teif_ref_2022_pct, ip_ref_2022_pct))
FAIXAS_META = {
    1: ('≤ 29 MW', 29, 94.584, 1.684, 3.796),
    2: ('29–59 MW', 59, 94.582, 1.844, 3.641),
    3: ('59–199 MW', 199, 94.761, 1.591, 3.707),
    4: ('199–499 MW', 499, 93.934, 2.681, 3.478),
    5: ('499–1300 MW', 1300, 95.545, 2.107, 2.399),
}

# Reconstituicao historica da Revisao 2022 (Jan/2016-Dez/2020, Anexo I do Relatorio Revisao 4)
VALIDACAO_2022_ANEXO_I = (
    (1, '≤ 29 MW', 29, 58, 56, 1.684, 1.7012142857142858, 3.796, 3.825339285714286, 94.584, 94.53852364697704, -0.04547635302296271, 'DIVERGÊNCIA'),
    (2, '29–59 MW', 59, 117, 117, 1.844, 1.843717948717949, 3.641, 3.6412564102564104, 94.582, 94.58216013902037, 0.00016013902038025662, 'REPRODUZ'),
    (3, '59–199 MW', 199, 239, 239, 1.591, 1.5908033472803347, 3.707, 3.7066234309623427, 94.761, 94.76153831136816, 0.0005383113681602936, 'REPRODUZ'),
    (4, '199–499 MW', 499, 94, 94, 2.681, 2.681287234042553, 3.478, 3.4775531914893616, 93.934, 93.93440276424853, 0.0004027642485340266, 'REPRODUZ'),
    (5, '499–1300 MW', 1300, 26, 26, 2.107, 2.1074615384615383, 2.399, 2.399, 95.545, 95.54409646384616, -0.0009035361538423103, 'REPRODUZ'),
)

# UGs auxiliares / de vazao remanescente desconsideradas no enquadramento de faixa
# conforme Relatorio Revisao 4 (secao 3.1 / Anexo I):
#   - Garibaldi (UG4 2,9 MW remanescente; consideradas 3 UGs principais de 63 MW)
#   - Santo Antonio do Jari (UG4 3,4 MW remanescente; consideradas 3 UGs principais de 129,85 MW)
#   - Tucurui (UGs 24-25 22,5 MW auxiliares; consideradas 23 UGs principais de 350/390 MW)
UGS_AUXILIARES_LIMITE_MW = {
    'UHE.PH.SC.030415-8.01': 10.0,
    'UHE.PH.AP.026792-9.01': 10.0,
    'UHE.PH.PA.002889-4.01': 50.0,
}

# Excecoes metodologicas da Revisao 4:
#   - Henry Borden: complexo com casas Externa (faixas 2 e 3) e Subterranea no mesmo CEG -> excluido
#   - Itaipu: binacional fora do MRA -> excluida por padrao, disponivel como simulacao (SIN83-GERAL)
CEG_HENRY_BORDEN = 'UHE.PH.SP.001084-7.01'
CEG_ITAIPU = 'UHE.PH.PR.001161-4.01'
CEG_BELO_MONTE = 'UHE.PH.PA.030354-2.01'

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


def _salvar_parquet_atomico(con, tabela, destino):
    """Exporta tabela DuckDB para Parquet via arquivo temporario (melhor esforco)."""
    try:
        destino = Path(destino)
        destino.parent.mkdir(parents=True, exist_ok=True)
        temporario = destino.with_suffix(destino.suffix + '.tmp')
        con.execute(f'COPY (SELECT * FROM {tabela}) TO ? (FORMAT PARQUET, COMPRESSION ZSTD)', [str(temporario)])
        temporario.replace(destino)
    except OSError:
        pass


def calcular_projecao_sin(con, raiz):
    """Cria tabelas DuckDB de projecao 2028 por faixa SIN e comparacao com as 12 UHEs CTG.

    O universo SIN e reconstruido automaticamente a partir dos Parquets oficiais do ONS
    (CAPACIDADE_GERACAO.parquet e TAXA_TEIF_TEIP.parquet), garantindo atualizacao continua
    de taxas, UGs ativas, novas motorizacoes e corte dinamico de 60 meses.
    """
    raiz = Path(raiz)
    arq_cap = raiz / 'dados/ons/cadastro/CAPACIDADE_GERACAO.parquet'
    arq_tax = raiz / 'dados/ons/taxas/TAXA_TEIF_TEIP.parquet'

    # 1. Metadados oficiais das 5 faixas + polos CTG
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

    # 2. Validacao cruzada 2022 (Anexo I do Relatorio Revisao 4) - embutida, sem arquivo externo
    con.execute('''
        CREATE OR REPLACE TABLE validacao_2022_faixas (
            faixa INTEGER,
            faixa_label VARCHAR,
            teto_mw INTEGER,
            ugs_publ INTEGER,
            ugs_base INTEGER,
            teif_publ_pct DOUBLE,
            teif_calc_pct DOUBLE,
            ip_publ_pct DOUBLE,
            ip_calc_pct DOUBLE,
            id_publ_pct DOUBLE,
            id_calc_pct DOUBLE,
            delta_id_pp DOUBLE,
            resultado VARCHAR
        )
    ''')
    con.executemany(
        'INSERT INTO validacao_2022_faixas VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        VALIDACAO_2022_ANEXO_I,
    )

    # 3. Construcao automatica do cadastro SIN a partir de CAPACIDADE_GERACAO + TAXA_TEIF_TEIP
    if arq_cap.is_file() and arq_tax.is_file():
        con.execute('''
            CREATE OR REPLACE TEMP TABLE _aux_ugs_remanescentes (
                cod_ceg VARCHAR,
                pot_min_mw DOUBLE
            )
        ''')
        con.executemany(
            'INSERT INTO _aux_ugs_remanescentes VALUES (?, ?)',
            list(UGS_AUXILIARES_LIMITE_MW.items()),
        )

        con.execute(f'''
            CREATE OR REPLACE TABLE cadastro_sin_faixas AS
            WITH tax_hidro_nomes AS (
                SELECT DISTINCT
                       trim(nom_usina) AS nom_ons,
                       coalesce(trim(cod_ceg), '') AS cod_ceg
                FROM read_parquet(?)
                WHERE upper(trim(tip_usina)) LIKE '%HIDR%'
            ),
            cap_ugs_raw AS (
                SELECT trim(ceg) AS cod_ceg,
                       trim(nom_usina) AS nom_cap,
                       trim(nom_unidadegeradora) AS nom_ug,
                       val_potenciaefetiva AS pot,
                       try_cast(dat_entradaoperacao AS DATE) AS dat_op,
                       CASE
                           WHEN val_potenciaefetiva <= 29 THEN 1
                           WHEN val_potenciaefetiva <= 59 THEN 2
                           WHEN val_potenciaefetiva <= 199 THEN 3
                           WHEN val_potenciaefetiva <= 499 THEN 4
                           WHEN val_potenciaefetiva <= 1300 THEN 5
                           ELSE 0
                       END AS faixa_ug
                FROM read_parquet(?)
                WHERE upper(trim(nom_tipousina)) LIKE '%HIDR%'
                  AND dat_desativacao IS NULL
                  AND val_potenciaefetiva > 0
                  AND ceg IS NOT NULL AND trim(ceg) <> ''
            ),
            cap_ugs AS (
                SELECT c.*
                FROM cap_ugs_raw c
                LEFT JOIN _aux_ugs_remanescentes a ON a.cod_ceg = c.cod_ceg
                WHERE a.cod_ceg IS NULL OR c.pot >= a.pot_min_mw
            ),
            matched_ugs AS (
                SELECT t.nom_ons,
                       t.cod_ceg,
                       c.nom_cap,
                       c.nom_ug,
                       c.pot,
                       c.dat_op,
                       c.faixa_ug,
                       (
                           upper(t.nom_ons) = upper(c.nom_cap)
                           OR position(
                               ' ' || upper(t.nom_ons) || ' '
                               IN ' ' || regexp_replace(upper(c.nom_ug), '\\s+', ' ', 'g') || ' '
                           ) > 0
                       ) AS ug_matches_name
                FROM tax_hidro_nomes t
                JOIN cap_ugs c ON t.cod_ceg = c.cod_ceg AND t.cod_ceg <> ''
            ),
            plant_ug_filtered AS (
                SELECT *,
                       max(CASE WHEN ug_matches_name THEN 1 ELSE 0 END)
                           OVER (PARTITION BY nom_ons, cod_ceg) AS has_name_match
                FROM matched_ugs
            ),
            agg_plant AS (
                SELECT nom_ons,
                       cod_ceg,
                       min(nom_cap) AS usina_cadastro,
                       count(*)::INTEGER AS ugs,
                       count(DISTINCT faixa_ug) AS n_faixas,
                       min(faixa_ug)::INTEGER AS faixa_min,
                       max(dat_op) AS motorizacao
                FROM plant_ug_filtered
                WHERE has_name_match = 0 OR ug_matches_name
                GROUP BY nom_ons, cod_ceg
            ),
            usinas_fisicas AS (
                SELECT
                    CASE
                        WHEN cod_ceg = '{CEG_BELO_MONTE}' AND upper(nom_ons) = 'BELO MONTE' THEN 'SIN76'
                        WHEN cod_ceg = '{CEG_BELO_MONTE}' AND upper(nom_ons) LIKE '%PIMENTAL%' THEN 'TAX165'
                        WHEN cod_ceg = '{CEG_ITAIPU}' AND upper(nom_ons) = 'ITAIPU 50 HZ' THEN 'SIN83-50HZ'
                        WHEN cod_ceg = '{CEG_ITAIPU}' AND upper(nom_ons) = 'ITAIPU 60 HZ' THEN 'SIN83'
                        ELSE 'SIN-' || cod_ceg || '-' || regexp_replace(upper(nom_ons), '[^A-Z0-9]+', '_', 'g')
                    END AS id_sin,
                    usina_cadastro,
                    nom_ons AS usina_ons,
                    cod_ceg,
                    CASE
                        WHEN n_faixas = 1 AND cod_ceg <> '{CEG_HENRY_BORDEN}' THEN faixa_min
                        ELSE 0
                    END AS faixa,
                    ugs,
                    motorizacao,
                    (n_faixas = 1 AND cod_ceg NOT IN ('{CEG_HENRY_BORDEN}', '{CEG_ITAIPU}')) AS incluida,
                    (n_faixas > 1 OR cod_ceg = '{CEG_HENRY_BORDEN}') AS excluida,
                    TRUE AS no_painel_base
                FROM agg_plant
            ),
            itaipu_geral AS (
                SELECT 'SIN83-GERAL' AS id_sin,
                       'ITAIPU' AS usina_cadastro,
                       'ITAIPU' AS usina_ons,
                       '{CEG_ITAIPU}' AS cod_ceg,
                       5::INTEGER AS faixa,
                       count(*)::INTEGER AS ugs,
                       max(dat_op) AS motorizacao,
                       FALSE AS incluida,
                       FALSE AS excluida,
                       FALSE AS no_painel_base
                FROM cap_ugs
                WHERE cod_ceg = '{CEG_ITAIPU}'
                HAVING count(*) > 0
            ),
            equivalentes_sem_ceg AS (
                SELECT 'TAX-' || regexp_replace(upper(nom_ons), '[^A-Z0-9]+', '_', 'g') AS id_sin,
                       nom_ons AS usina_cadastro,
                       nom_ons AS usina_ons,
                       '' AS cod_ceg,
                       0::INTEGER AS faixa,
                       0::INTEGER AS ugs,
                       NULL::DATE AS motorizacao,
                       FALSE AS incluida,
                       TRUE AS excluida,
                       TRUE AS no_painel_base
                FROM tax_hidro_nomes
                WHERE cod_ceg = '' AND upper(nom_ons) <> 'ITAIPU'
            )
            SELECT * FROM usinas_fisicas
            UNION ALL
            SELECT * FROM itaipu_geral
            UNION ALL
            SELECT * FROM equivalentes_sem_ceg
            ORDER BY faixa, usina_cadastro, usina_ons
        ''', [str(arq_tax), str(arq_cap)])
    else:
        con.execute('''
            CREATE OR REPLACE TABLE cadastro_sin_faixas (
                id_sin VARCHAR, usina_cadastro VARCHAR, usina_ons VARCHAR, cod_ceg VARCHAR,
                faixa INTEGER, ugs INTEGER, motorizacao DATE, incluida BOOLEAN,
                excluida BOOLEAN, no_painel_base BOOLEAN
            )
        ''')

    # 4. Ultimas taxas SIN (competencia mais recente publicada no TAXA_TEIF_TEIP.parquet)
    if arq_tax.is_file():
        con.execute('''
            CREATE OR REPLACE TABLE sin_usinas_taxas_ultimas AS
            WITH competencia AS (
                SELECT max(din_mes::DATE) AS mes_ref_ons
                FROM read_parquet(?)
            ),
            ult AS (
                SELECT trim(o.nom_usina) AS nom_usina,
                       coalesce(trim(o.cod_ceg), '') AS cod_ceg,
                       o.din_mes::DATE AS mes_ons,
                       upper(trim(o.nom_taxa)) AS taxa,
                       o.val_taxa
                FROM read_parquet(?) o
                CROSS JOIN competencia c
                WHERE o.din_mes::DATE = c.mes_ref_ons
                  AND upper(trim(o.tip_usina)) LIKE '%HIDR%'
                QUALIFY row_number() OVER (
                    PARTITION BY trim(o.nom_usina), coalesce(trim(o.cod_ceg), ''), upper(trim(o.nom_taxa))
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
             AND (
                 s.cod_ceg = p.cod_ceg
                 OR (s.id_sin = 'SIN83-GERAL' AND p.cod_ceg = '')
             )
        ''', [str(arq_tax), str(arq_tax)])
    else:
        con.execute('''
            CREATE OR REPLACE TABLE sin_usinas_taxas_ultimas (
                id_sin VARCHAR, usina_cadastro VARCHAR, usina_ons VARCHAR, cod_ceg VARCHAR,
                faixa INTEGER, ugs INTEGER, motorizacao DATE, incluida BOOLEAN,
                excluida BOOLEAN, no_painel_base BOOLEAN, mes_ons DATE,
                teifa_pct DOUBLE, teip_pct DOUBLE, id_atual_pct DOUBLE,
                valida_calculo BOOLEAN, usina_ctg BOOLEAN
            )
        ''')

    # 5. Consolidacao por faixa de potencia (metodologia Relatorio Revisao 4, secao 3.1)
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

    # 6. Analise das 12 UHEs CTG comparando ID atual 60m vs Ref MME 2022 vs Projecao Faixa 2028
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

    # Persiste os Parquets derivados em dados/referencias_sin para auditoria no Explorador Parquet
    _salvar_parquet_atomico(con, 'cadastro_sin_faixas', raiz / 'dados/referencias_sin' / ARQUIVO_SIN_PARQUET.name)
    _salvar_parquet_atomico(con, 'validacao_2022_faixas', raiz / 'dados/referencias_sin' / ARQUIVO_VALIDACAO_2022_PARQUET.name)
