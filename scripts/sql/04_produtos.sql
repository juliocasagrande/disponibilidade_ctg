-- Produtos de dados em formato aberto, com uma coluna para cada tipo de hora.
CREATE OR REPLACE VIEW horas_ug_mensal_ctg AS
SELECT mes AS data, cod_ceg, usina AS nome_usina, numero_ug AS ug,
       unidade AS nome_ug, potencia_calculo_mw AS potencia_ug_mw,
       hdp AS HDP, hdf AS HDF, hedp AS HEDP, hedf AS HEDF,
       hs AS HS, hrd AS HRD, hdce AS HDCE, hp AS HP,
       versao, fonte_potencia, parametros_validos, horas_validas,
       usa_referencia, valido, saldo_horas, ressalva_fechamento,
       motivo_ressalva, fonte_ressalva
FROM parcelas_ug_mensal
WHERE operada_ctg AND mes >= (SELECT min(mes) FROM parametros_ctg_brutos);

CREATE OR REPLACE VIEW parcelas_usina_mensal_ctg AS
SELECT * FROM parcelas_usina_mensal
WHERE operada_ctg AND mes >= (SELECT min(mes) FROM parametros_ctg_brutos);

CREATE OR REPLACE TABLE referencias_fid_ctg AS
SELECT d.cod_ceg, d.usina, r.teif_referencia, r.ip_referencia,
       r.id_referencia, r.inicio_vigencia, r.fonte_url, r.consulta_utc
FROM read_parquet('dados/mme/REFERENCIAS_FID.parquet') r
JOIN dim_usinas_ctg d USING (cod_ceg);

SELECT CASE WHEN (SELECT count(*) FROM referencias_fid_ctg)=(SELECT count(*) FROM dim_usinas_ctg)
    AND (SELECT count(DISTINCT cod_ceg) FROM referencias_fid_ctg)=(SELECT count(*) FROM dim_usinas_ctg)
    AND (SELECT bool_and(id_referencia > 0 AND id_referencia <= 1
                        AND teif_referencia BETWEEN 0 AND 1
                        AND ip_referencia BETWEEN 0 AND 1) FROM referencias_fid_ctg)
    THEN true ELSE error('Referencias FID incompletas ou duplicadas para as usinas CTG.') END;

-- IDv calculado com as taxas acumuladas; ID de referencia da garantia fisica.
CREATE OR REPLACE VIEW indicadores_disponibilidade_ctg AS
WITH t AS (
 SELECT a.*, (1-a.teifa)*(1-a.teip) AS id_verificado,
        r.teif_referencia, r.ip_referencia, r.id_referencia,
        r.inicio_vigencia AS inicio_vigencia_referencia, r.fonte_url AS fonte_referencia
 FROM taxas_60_meses_ctg a
 LEFT JOIN referencias_fid_ctg r ON a.cod_ceg=r.cod_ceg
      AND a.mes_referencia_contabil >= r.inicio_vigencia
), f AS (
 SELECT *, id_verificado/nullif(id_referencia,0) AS fid_bruto FROM t
)
SELECT *, 100*id_verificado AS id_verificado_pct,
       CASE WHEN fid_bruto IS NOT NULL THEN least(1.0,fid_bruto) END AS fid_mra
FROM f;
