-- Entradas: historico (parcelas mensais reais), cenario_horas e configuracao.
-- Cada mes projetado entra na janela e o mais antigo sai. Nao promediar taxas.
CREATE OR REPLACE TABLE resultado_cenario AS
WITH futuros AS (
 SELECT cod_ceg, mes, true AS mes_valido,
        sum(potencia_ug_mw*(HDF+HEDF)) AS numerador_teifa,
        sum(potencia_ug_mw*(HDF+HEDF+HS+HDCE+HRD)) AS denominador_teifa,
        sum(potencia_ug_mw*(HDP+HEDP)) AS numerador_teip,
        sum(potencia_ug_mw*HP) AS denominador_teip
 FROM cenario_horas GROUP BY cod_ceg,mes
), serie AS (
 SELECT cod_ceg,mes,mes_valido,numerador_teifa,denominador_teifa,numerador_teip,denominador_teip
 FROM historico WHERE cod_ceg=(SELECT cod_ceg FROM configuracao)
 UNION ALL
 SELECT * FROM futuros
), acumulado AS (
 SELECT *, count(*) FILTER(WHERE mes_valido) OVER w AS meses_validos,
        sum(numerador_teifa) OVER w / nullif(sum(denominador_teifa) OVER w,0) AS teifa_calc,
        sum(numerador_teip) OVER w / nullif(sum(denominador_teip) OVER w,0) AS teip_calc
 FROM serie WINDOW w AS (PARTITION BY cod_ceg ORDER BY mes
      RANGE BETWEEN INTERVAL '59 months' PRECEDING AND CURRENT ROW)
), taxas AS (
 SELECT a.cod_ceg, c.usina, a.mes AS mes_fim_historico,
        (a.mes-INTERVAL '59 months')::DATE AS mes_inicio_historico,
        (a.mes+INTERVAL '1 month')::DATE AS mes_referencia_contabil,
        (a.mes-INTERVAL '60 months')::DATE AS mes_excluido,
        a.meses_validos,
        CASE WHEN a.meses_validos=60 THEN a.teifa_calc END AS teifa,
        CASE WHEN a.meses_validos=60 THEN a.teip_calc END AS teip,
        c.id_referencia, c.fonte_referencia
 FROM acumulado a CROSS JOIN configuracao c
 WHERE a.mes > c.mes_base
), indices AS (
 SELECT *, (1-teifa)*(1-teip) AS id_verificado,
        (1-teifa)*(1-teip)/nullif(id_referencia,0) AS fid_bruto FROM taxas
)
SELECT *, CASE WHEN fid_bruto IS NOT NULL THEN least(1.0,fid_bruto) END AS fid_mra
FROM indices ORDER BY mes_fim_historico;
