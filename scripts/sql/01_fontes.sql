-- Executar a partir da raiz do projeto. Fontes publicas: ONS / CC BY.
CREATE OR REPLACE TABLE dim_usinas_ctg AS
SELECT * FROM (VALUES
 ('UHE.PH.SP.000647-5.01', 'Canoas I',       true,  3),
 ('UHE.PH.SP.027092-0.01', 'Canoas II',      true,  3),
 ('UHE.PH.SP.000657-2.01', 'Capivara',       true,  4),
 ('UHE.PH.SP.000764-1.01', 'Chavantes',      true,  4),
 ('UHE.PH.SC.030415-8.01', 'Garibaldi',      true,  3),
 ('UHE.PH.SP.001120-7.01', 'Ilha Solteira',  true, 20),
 ('UHE.PH.SP.001282-3.01', 'Jupia',          true, 14),
 ('UHE.PH.SP.001285-8.01', 'Jurumirim',      true,  2),
 ('UHE.PH.SP.002555-0.01', 'Rosana',         true,  4),
 ('UHE.PH.GO.028758-0.01', 'Salto',          true,  2),
 ('UHE.PH.SP.002648-4.01', 'Salto Grande SP',true,  4),
 ('UHE.PH.SP.002821-5.01', 'Taquarucu',      true,  5)
) AS t(cod_ceg, usina, operada_ctg, quantidade_ugs_escopo);

-- Cadastro atual: nao contem historico de alteracoes de potencia.
CREATE OR REPLACE TABLE cadastro_ugs_ctg AS
SELECT d.*, trim(c.cod_equipamento) AS cod_equipamento,
       trim(c.nom_unidadegeradora) AS unidade,
       try_cast(trim(c.num_unidadegeradora) AS INTEGER) AS numero_ug,
       c.val_potenciaefetiva AS potencia_mw,
       trim(c.nom_agenteproprietario) AS proprietario,
       trim(c.nom_agenteoperador) AS operador,
       try_cast(c.dat_entradaoperacao AS DATE) AS entrada_comercial,
       try_cast(c.dat_desativacao AS DATE) AS desativacao
FROM read_parquet('dados/ons/cadastro/CAPACIDADE_GERACAO.parquet') c
JOIN dim_usinas_ctg d ON trim(c.ceg) = d.cod_ceg;

-- CEG + numero da UG evita depender da grafia ou da potencia no nome.
-- Garibaldi UG4 (2,9 MW) nao consta da base de parametros recebida.
CREATE OR REPLACE VIEW dim_ugs_ctg AS
SELECT * FROM cadastro_ugs_ctg
WHERE numero_ug BETWEEN 1 AND quantidade_ugs_escopo;

CREATE TABLE IF NOT EXISTS potencia_ug_mensal (
    cod_ceg VARCHAR, numero_ug INTEGER, mes DATE,
    potencia_mw DOUBLE CHECK (isfinite(potencia_mw) AND potencia_mw > 0),
    fonte VARCHAR NOT NULL,
    PRIMARY KEY (cod_ceg, numero_ug, mes),
    CHECK (mes = date_trunc('month', mes))
);

-- Preencher SOMENTE com referencias oficiais da garantia fisica para
-- meses inteiros sem parametros observados. Nao preenche lacunas com zero.
CREATE TABLE IF NOT EXISTS referencia_ug_mensal (
    cod_ceg VARCHAR, numero_ug INTEGER, mes DATE,
    teif_referencia DOUBLE NOT NULL CHECK (teif_referencia BETWEEN 0 AND 1),
    teip_referencia DOUBLE NOT NULL CHECK (teip_referencia BETWEEN 0 AND 1),
    fonte VARCHAR NOT NULL,
    PRIMARY KEY (cod_ceg, numero_ug, mes),
    CHECK (mes = date_trunc('month', mes))
);

CREATE OR REPLACE TABLE parametros_ctg_brutos AS
SELECT d.cod_ceg, d.usina, d.operada_ctg,
       trim(p.nom_unidadegeradora) AS unidade_original,
       try_cast(regexp_extract(trim(p.nom_unidadegeradora),
                    '([0-9]+) [A-Z]{2}$', 1) AS INTEGER) AS numero_ug,
       coalesce(try_strptime(trim(p.dat_periodo),
                   ['%m/%Y', '%Y-%m', '%Y-%m-%d'])::DATE,
                date_trunc('month', p.din_parametro)::DATE) AS mes,
       upper(trim(p.nom_tpinsumo)) AS insumo,
       p.val_parametro AS valor, p.num_versao AS versao,
       p.filename AS arquivo_origem
FROM read_parquet('dados/ons/parametros/TAXA_TEIF_TEIP_PARAM_*.parquet',
                  union_by_name = true, filename = true) p
JOIN dim_usinas_ctg d ON trim(p.cod_ceg) = d.cod_ceg;

-- A revisao e por UG/mes, nao por usina/mes. Nao misturar parametros
-- de versoes diferentes dentro de uma mesma UG/mes.
CREATE OR REPLACE TABLE parametros_ctg_revisados AS
SELECT * FROM parametros_ctg_brutos
QUALIFY versao = max(versao) OVER (PARTITION BY cod_ceg, numero_ug, mes);

-- Duplicatas identicas contam uma vez; valores conflitantes sao sinalizados.
CREATE OR REPLACE TABLE parametros_ctg AS
SELECT cod_ceg, numero_ug, mes, insumo, max(valor) AS valor,
       max(versao) AS versao, count(*) AS linhas_origem,
       count(DISTINCT valor) <> 1 OR count(valor) <> count(*) AS conflito
FROM parametros_ctg_revisados
GROUP BY cod_ceg, numero_ug, mes, insumo;

CREATE OR REPLACE TABLE horas_ug_mensal AS
SELECT cod_ceg, numero_ug, mes, max(versao) AS versao,
       max(valor) FILTER (WHERE insumo = 'HDF') AS hdf,
       max(valor) FILTER (WHERE insumo = 'HEDF') AS hedf,
       max(valor) FILTER (WHERE insumo = 'HDP') AS hdp,
       max(valor) FILTER (WHERE insumo = 'HEDP') AS hedp,
       max(valor) FILTER (WHERE insumo = 'HP') AS hp,
       max(valor) FILTER (WHERE insumo = 'HS') AS hs,
       max(valor) FILTER (WHERE insumo = 'HRD') AS hrd,
       max(valor) FILTER (WHERE insumo = 'HDCE') AS hdce,
       count(*) AS quantidade_insumos,
       count(*) = 8
           AND bool_and(insumo IN ('HDF','HEDF','HDP','HEDP','HP','HS','HRD','HDCE'))
           AND bool_and(NOT conflito AND isfinite(valor) AND valor >= 0)
           AS parametros_validos
FROM parametros_ctg
GROUP BY cod_ceg, numero_ug, mes;

-- Ressalva local revisada em 25/11/2026. O Parquet e o CSV oficiais trazem
-- estes valores; as 34 taxas das 17 janelas completas afetadas conciliam
-- usando os parametros originais. Nao se atribui o saldo a outro insumo.
-- A ressalva so se aplica enquanto todos os valores da UG forem identicos
-- aos revisados. Novos valores/versoes passam pelo controle normal.
CREATE OR REPLACE TABLE ressalvas_fechamento_ons AS
SELECT 'UHE.PH.SP.001120-7.01' AS cod_ceg, DATE '2021-05-01' AS mes,
       numero_ug, 1.0::DOUBLE AS versao, 744.0::DOUBLE AS hp,
       hdf::DOUBLE AS hdf, hdp::DOUBLE AS hdp, hs::DOUBLE AS hs,
       'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/taxa_teif_teip_parametro/TAXA_TEIF_TEIP_PARAM_2021.parquet' AS fonte_url,
       'Parametros originais ONS com saldo de horas; taxas conciliadas em 17 janelas, sem imputacao de horas.' AS motivo
FROM (VALUES
    (5,   0.00000000,  14.73333333, 638.86666667),
    (6,   0.00000000,   0.00000000, 496.81666667),
    (7,  13.16666667,  11.68333333, 397.13333333),
    (8,   0.00000000,  92.61666667,   0.00000000),
    (9,   0.00000000,   0.00000000,   0.00000000),
    (10,  0.00000000, 128.28333333, 140.98333333),
    (14,  0.00000000,   0.00000000, 427.45000000),
    (15,  0.00000000,   2.15000000, 613.53333333),
    (16,  0.00000000,  26.33333333, 674.31666667),
    (17,  0.00000000,   0.00000000, 281.61666667),
    (18,  0.00000000,   0.00000000, 328.28333333),
    (19, 39.21666667,  19.00000000, 321.61666667),
    (20,  0.00000000,  28.61666667, 336.68333333)
) AS v(numero_ug, hdf, hdp, hs);

CREATE OR REPLACE TABLE taxas_ons AS
SELECT trim(o.cod_ceg) AS cod_ceg, din_mes::DATE AS mes_ons,
       upper(trim(nom_taxa)) AS taxa, val_taxa, num_versao, din_calculo
FROM read_parquet('dados/ons/taxas/TAXA_TEIF_TEIP.parquet') o
JOIN dim_usinas_ctg d ON trim(o.cod_ceg) = d.cod_ceg
QUALIFY row_number() OVER (
    PARTITION BY trim(o.cod_ceg), din_mes, upper(trim(nom_taxa))
    ORDER BY num_versao DESC, din_calculo DESC) = 1;
