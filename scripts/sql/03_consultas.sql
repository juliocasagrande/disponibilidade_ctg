-- Mensal, somente UGs das usinas operadas pela CTG.
SELECT usina, mes, teifa_pct, teip_pct, mes_valido, ugs_validas, quantidade_ugs_escopo
FROM taxas_mensais_ctg
WHERE mes = (SELECT max(mes) FROM taxas_mensais_ctg)
ORDER BY usina;

-- Ultimos 60 meses: por exemplo novembro/2021 a outubro/2026,
-- aplicaveis a referencia contabil novembro/2026.
SELECT usina, mes_referencia_contabil, mes_inicio_historico, mes_fim_historico,
       teifa_pct, teip_pct, meses_validos, janela_completa
FROM taxas_60_meses_ctg
WHERE mes_fim_historico = (SELECT max(mes_fim_historico) FROM taxas_60_meses_ctg)
ORDER BY usina;

-- Comparar os calculos das usinas da CTG com as taxas publicadas pelo ONS.
SELECT * FROM conciliacao_ons
WHERE mes_fim_historico = (SELECT max(mes_fim_historico) FROM taxas_60_meses)
ORDER BY usina, taxa;

-- Unidades do cadastro fora do escopo dos parametros.
SELECT * FROM auditoria_ugs WHERE NOT no_escopo OR NOT possui_parametros;

-- Lacunas e erros nos meses efetivamente recebidos (sem os meses de aquecimento).
SELECT cod_ceg, usina, numero_ug, mes, quantidade_insumos, parametros_validos,
       hp, hdf, hedf, hdp, hedp, hs, hrd, hdce
FROM parcelas_ug_mensal
WHERE NOT valido AND mes >= (SELECT min(mes) FROM parametros_ctg_brutos)
ORDER BY usina, numero_ug, mes;
