-- REN 1.033/2022 e ONS RO-AO.BR.04, revisao 47, Anexo 3.
-- Taxas em fracao (0 a 1); colunas *_pct em porcentagem.
CREATE OR REPLACE TABLE calendario AS
SELECT unnest(generate_series(
    (SELECT min(mes) - INTERVAL '59 months' FROM parametros_ctg_brutos),
    (SELECT max(mes) FROM parametros_ctg_brutos), INTERVAL '1 month'))::DATE AS mes;

CREATE OR REPLACE TABLE parcelas_ug_mensal AS
WITH grade AS (
    SELECT u.*, c.mes,
           date_diff('hour', c.mes, c.mes + INTERVAL '1 month') AS horas_calendario,
           coalesce(p.potencia_mw, u.potencia_mw) AS potencia_calculo_mw,
           CASE WHEN p.potencia_mw IS NULL THEN 'CADASTRO_ATUAL_ONS'
                ELSE p.fonte END AS fonte_potencia
    FROM dim_ugs_ctg u CROSS JOIN calendario c
    LEFT JOIN potencia_ug_mensal p USING (cod_ceg, numero_ug, mes)
), base AS (
    SELECT g.*, h.* EXCLUDE (cod_ceg, numero_ug, mes),
           r.teif_referencia, r.teip_referencia, r.fonte AS fonte_referencia,
           h.quantidade_insumos IS NULL AND r.fonte IS NOT NULL AS usa_referencia,
           h.hp - (h.hdf+h.hedf+h.hdp+h.hedp+h.hs+h.hrd+h.hdce) AS saldo_horas,
           coalesce(e.numero_ug IS NOT NULL AND h.parametros_validos
                    AND h.hp > 0 AND h.hp <= g.horas_calendario + 0.01,
                    false) AS ressalva_fechamento,
           e.motivo AS motivo_ressalva, e.fonte_url AS fonte_ressalva,
           coalesce(h.parametros_validos AND h.hp > 0
                    AND h.hp <= g.horas_calendario + 0.01
                    AND abs(h.hp - (h.hdf+h.hedf+h.hdp+h.hedp+h.hs+h.hrd+h.hdce)) <= 0.01,
                    false) AS horas_validas
    FROM grade g
    LEFT JOIN horas_ug_mensal h USING (cod_ceg, numero_ug, mes)
    LEFT JOIN referencia_ug_mensal r USING (cod_ceg, numero_ug, mes)
    LEFT JOIN ressalvas_fechamento_ons e
        ON e.cod_ceg=g.cod_ceg AND e.numero_ug=g.numero_ug AND e.mes=g.mes
       AND h.versao=e.versao AND h.hp=e.hp
       AND h.hdf=e.hdf AND h.hdp=e.hdp AND h.hs=e.hs
       AND h.hedf=0 AND h.hedp=0 AND h.hrd=0 AND h.hdce=0
)
SELECT *,
       coalesce(potencia_calculo_mw > 0 AND isfinite(potencia_calculo_mw)
           AND (horas_validas OR ressalva_fechamento OR usa_referencia), false) AS valido,
       CASE WHEN usa_referencia THEN potencia_calculo_mw * horas_calendario
                    * teif_referencia * (1-teip_referencia)
            ELSE potencia_calculo_mw * (hdf+hedf) END AS numerador_teifa,
       CASE WHEN usa_referencia THEN potencia_calculo_mw * horas_calendario
                    * (1-teip_referencia)
            ELSE potencia_calculo_mw * (hdf+hedf+hs+hdce+hrd) END AS denominador_teifa,
       CASE WHEN usa_referencia THEN potencia_calculo_mw * horas_calendario * teip_referencia
            ELSE potencia_calculo_mw * (hdp+hedp) END AS numerador_teip,
       CASE WHEN usa_referencia THEN potencia_calculo_mw * horas_calendario
            ELSE potencia_calculo_mw * hp END AS denominador_teip
FROM base;

CREATE OR REPLACE TABLE parcelas_usina_mensal AS
SELECT cod_ceg, usina, operada_ctg, mes, quantidade_ugs_escopo,
       count(*) AS ugs_cadastradas,
       count(*) FILTER (WHERE valido) AS ugs_validas,
       count(*) FILTER (WHERE usa_referencia) AS ugs_referencia,
       count(*) FILTER (WHERE valido AND ressalva_fechamento) AS ugs_com_ressalva,
       count(*) = quantidade_ugs_escopo AND bool_and(valido) AS mes_valido,
       sum(numerador_teifa) FILTER (WHERE valido) AS numerador_teifa,
       sum(denominador_teifa) FILTER (WHERE valido) AS denominador_teifa,
       sum(numerador_teip) FILTER (WHERE valido) AS numerador_teip,
       sum(denominador_teip) FILTER (WHERE valido) AS denominador_teip
FROM parcelas_ug_mensal
GROUP BY cod_ceg, usina, operada_ctg, mes, quantidade_ugs_escopo;

CREATE OR REPLACE TABLE taxas_mensais AS
WITH t AS (
 SELECT *, CASE WHEN mes_valido THEN numerador_teifa / nullif(denominador_teifa,0) END AS teifa,
           CASE WHEN mes_valido THEN numerador_teip / nullif(denominador_teip,0) END AS teip
 FROM parcelas_usina_mensal
 WHERE mes >= (SELECT min(mes) FROM parametros_ctg_brutos)
)
SELECT *, 100*teifa AS teifa_pct, 100*teip AS teip_pct FROM t;

-- Janela por calendario: uma lacuna nao pode puxar um mes mais antigo.
-- mes_fim_historico e inclusivo; mes_referencia_contabil e o mes seguinte.
CREATE OR REPLACE TABLE taxas_60_meses AS
WITH acumulado AS (
 SELECT cod_ceg, usina, operada_ctg, mes AS mes_fim_historico,
        (mes - INTERVAL '59 months')::DATE AS mes_inicio_historico,
        (mes + INTERVAL '1 month')::DATE AS mes_referencia_contabil,
        count(*) FILTER (WHERE mes_valido) OVER w AS meses_validos,
        count(*) FILTER (WHERE mes_valido AND ugs_referencia > 0) OVER w AS meses_com_referencia,
        count(*) FILTER (WHERE mes_valido AND ugs_com_ressalva > 0) OVER w AS meses_com_ressalva,
        sum(numerador_teifa) OVER w AS numerador_teifa,
        sum(denominador_teifa) OVER w AS denominador_teifa,
        sum(numerador_teip) OVER w AS numerador_teip,
        sum(denominador_teip) OVER w AS denominador_teip
 FROM parcelas_usina_mensal
 WINDOW w AS (PARTITION BY cod_ceg ORDER BY mes
              RANGE BETWEEN INTERVAL '59 months' PRECEDING AND CURRENT ROW)
), taxas AS (
 SELECT *, meses_validos = 60 AS janela_completa,
        CASE WHEN meses_validos = 60 THEN numerador_teifa / nullif(denominador_teifa,0) END AS teifa,
        CASE WHEN meses_validos = 60 THEN numerador_teip / nullif(denominador_teip,0) END AS teip
 FROM acumulado
 WHERE mes_fim_historico >= (SELECT min(mes) FROM parametros_ctg_brutos)
)
SELECT *, 100*teifa AS teifa_pct, 100*teip AS teip_pct FROM taxas;

-- Filtro padrao: 12 UHEs operadas pela CTG, 68 UGs presentes nos parametros.
CREATE OR REPLACE VIEW taxas_mensais_ctg AS SELECT * FROM taxas_mensais WHERE operada_ctg;
CREATE OR REPLACE VIEW taxas_60_meses_ctg AS SELECT * FROM taxas_60_meses WHERE operada_ctg;

CREATE OR REPLACE VIEW conciliacao_ons AS
SELECT t.cod_ceg, t.usina, t.operada_ctg, t.mes_fim_historico,
       t.mes_referencia_contabil, t.meses_validos, t.janela_completa, t.meses_com_ressalva,
       v.taxa, v.calculada, o.val_taxa AS publicada,
       100*(v.calculada-o.val_taxa) AS diferenca_pp,
       CASE WHEN NOT t.janela_completa THEN 'HISTORICO_INCOMPLETO'
            WHEN v.calculada IS NULL THEN 'SEM_DENOMINADOR'
            WHEN o.val_taxa IS NULL THEN 'SEM_TAXA_ONS'
            WHEN abs(v.calculada-o.val_taxa) <= 0.0000000051 THEN 'OK'
            ELSE 'DIVERGENCIA' END AS status
FROM taxas_60_meses t
CROSS JOIN LATERAL (VALUES ('TEIFA',t.teifa),('TEIP',t.teip)) v(taxa,calculada)
LEFT JOIN taxas_ons o ON o.cod_ceg=t.cod_ceg
    AND o.mes_ons=t.mes_fim_historico AND o.taxa=v.taxa;

CREATE OR REPLACE VIEW auditoria_ugs AS
SELECT cod_ceg, usina, numero_ug, unidade, potencia_mw,
       numero_ug BETWEEN 1 AND quantidade_ugs_escopo AS no_escopo,
       EXISTS (SELECT 1 FROM parametros_ctg p
               WHERE p.cod_ceg=c.cod_ceg AND p.numero_ug=c.numero_ug) AS possui_parametros
FROM cadastro_ugs_ctg c;

CREATE OR REPLACE VIEW auditoria_parametros AS
SELECT p.* FROM parametros_ctg_brutos p
WHERE mes IS NULL OR numero_ug IS NULL OR versao IS NULL
   OR NOT EXISTS (SELECT 1 FROM dim_ugs_ctg u
                  WHERE u.cod_ceg=p.cod_ceg AND u.numero_ug=p.numero_ug);

CREATE OR REPLACE VIEW auditoria_fechamento_horas AS
SELECT cod_ceg, usina, numero_ug, mes, versao, hp,
       hdf+hedf+hdp+hedp+hs+hrd+hdce AS soma_horas, saldo_horas,
       parametros_validos, horas_validas, ressalva_fechamento, valido,
       motivo_ressalva, fonte_ressalva
FROM parcelas_ug_mensal
WHERE quantidade_insumos IS NOT NULL AND NOT horas_validas;
