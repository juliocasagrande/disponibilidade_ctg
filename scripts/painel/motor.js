/* Motor independente da interface. Meses sao YYYY-MM, sem fuso horario local. */
(function (root) {
  'use strict';
  const CAMPOS = ['HDP', 'HDF', 'HEDP', 'HEDF', 'HRD', 'HDCE'];
  const mesDe = valor => String(valor).slice(0, 7);

  function moverMes(mes, deslocamento) {
    const [ano, numero] = mesDe(mes).split('-').map(Number);
    const total = ano * 12 + numero - 1 + deslocamento;
    return `${Math.floor(total / 12)}-${String(((total % 12) + 12) % 12 + 1).padStart(2, '0')}`;
  }

  function horasMes(mes) {
    const [a, m] = mesDe(mes).split('-').map(Number);
    return new Date(Date.UTC(a, m, 0)).getUTCDate() * 24;
  }

  function indicadores(nf, df, np, dp, idRef, valido) {
    const teifa = valido && df > 0 ? nf / df : null;
    const teip = valido && dp > 0 ? np / dp : null;
    const id = teifa !== null && teip !== null ? (1 - teifa) * (1 - teip) : null;
    const fid = id !== null && idRef > 0 ? id / idRef : null;
    return {
      teifa,
      teip,
      id_verificado: id,
      fid_bruto: fid,
      fid_mra: fid === null ? null : Math.min(1, fid),
    };
  }

  function projetar(dados, ceg, horizonte, edicoes = {}, idRef = undefined) {
    if (!Number.isInteger(horizonte) || horizonte < 1 || horizonte > 120) {
      throw new Error('Escolha entre 1 e 120 meses.');
    }
    const usina = dados.usinas.find(u => u.cod_ceg === ceg);
    if (!usina) throw new Error('Selecione uma usina para simular.');
    if (idRef === undefined) idRef = usina.id_referencia;
    if (!Number.isFinite(idRef) || idRef <= 0 || idRef > 1) {
      throw new Error('O ID de referência deve ser maior que 0 e até 100%.');
    }
    const ugs = dados.horas
      .filter(u => u.cod_ceg === ceg && mesDe(u.data) === dados.mes_base)
      .map(u => ({ ug: u.ug, potencia_mw: u.potencia_ug_mw }));
    if (!ugs.length || ugs.some(u => !Number.isFinite(u.potencia_mw) || u.potencia_mw <= 0)) {
      throw new Error('Potência das UGs incompleta.');
    }
    const serie = dados.mensal
      .filter(m => m.cod_ceg === ceg)
      .map(m => ({
        mes: mesDe(m.mes),
        valido: m.mes_valido,
        nf: m.numerador_teifa,
        df: m.denominador_teifa,
        np: m.numerador_teip,
        dp: m.denominador_teip,
      }));
    const resultados = [];
    const plano = [];
    for (let i = 1; i <= horizonte; i++) {
      const mes = moverMes(dados.mes_base, i);
      const hp = horasMes(mes);
      let nf = 0, df = 0, np = 0, dp = 0;
      for (const ug of ugs) {
        const entrada = edicoes[`${mes}|${ug.ug}`] || {};
        const horas = {};
        for (const campo of CAMPOS) {
          const valor = entrada[campo] ?? 0;
          if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) {
            throw new Error(`UG ${ug.ug}, ${mes}: ${campo} inválido.`);
          }
          horas[campo] = valor;
        }
        const usadas = CAMPOS.reduce((s, c) => s + horas[c], 0);
        if (usadas > hp + 1e-7) {
          throw new Error(`UG ${ug.ug}, ${mes}: a soma das horas supera HP (${hp} h).`);
        }
        const hs = Math.max(0, hp - usadas);
        const p = ug.potencia_mw;
        nf += p * (horas.HDF + horas.HEDF);
        df += p * (horas.HDF + horas.HEDF + hs + horas.HDCE + horas.HRD);
        np += p * (horas.HDP + horas.HEDP);
        dp += p * hp;
        plano.push({ mes, ug: ug.ug, potencia_ug_mw: p, ...horas, HP: hp, HS: hs });
      }
      serie.push({ mes, valido: true, nf, df, np, dp });
      const inicio = moverMes(mes, -59);
      const janela = serie.filter(m => m.mes >= inicio && m.mes <= mes);
      const validos = janela.filter(m => m.valido).length;
      const soma = campo => janela.reduce((s, m) => s + (m[campo] ?? 0), 0);
      resultados.push({
        mes,
        mes_inicio_historico: inicio,
        mes_referencia_contabil: moverMes(mes, 1),
        mes_excluido: moverMes(mes, -60),
        meses_validos: validos,
        id_referencia: idRef,
        ...indicadores(soma('nf'), soma('df'), soma('np'), soma('dp'), idRef, validos === 60),
      });
    }
    return { resultados, plano };
  }

  /**
   * Converte as paradas programadas (manutencoes_mensal) em mapa de edicoes
   * { "YYYY-MM|ug": { HDP, HRD, HDCE } } para os meses futuros do horizonte da usina.
   *
   * Com aplicarExpurgos=true (padrao, conforme ONS RO-AO.BR.04 Rev. 47):
   *   - HDP recebe a indisponibilidade liquida (apos consumo cronologico do expurgo)
   *   - HRD recebe horas expurgadas de origens 7.1.3.2 (GIS, GIM, GMT, GIC)
   *   - HDCE recebe horas expurgadas de origens 7.1.3.3 (GRE, GHN, GRB) e GCI
   * Com aplicarExpurgos=false (cenario conservador sem expurgo):
   *   - Todas as horas brutas (HDP + HRD + HDCE) entram em HDP.
   */
  function construirEdicoesPlano(dados, ceg, horizonte, opcoes = {}) {
    const incluirMod = opcoes.incluirMod !== false;
    const incluirMpp = opcoes.incluirMpp !== false;
    const incluirOutros = opcoes.incluirOutros !== false;
    const aplicarExpurgos = opcoes.aplicarExpurgos !== false;
    const lista = dados.manutencoes_mensal || [];
    const mesInicio = moverMes(dados.mes_base, 1);
    const mesFim = moverMes(dados.mes_base, horizonte);
    const ugsValidos = new Set(
      dados.horas.filter(u => u.cod_ceg === ceg && mesDe(u.data) === dados.mes_base).map(u => u.ug)
    );
    const edicoes = {};
    for (const item of lista) {
      if (item.cod_ceg !== ceg) continue;
      if (!ugsValidos.has(item.ug)) continue;
      const m = mesDe(item.mes);
      if (m < mesInicio || m > mesFim) continue;
      const soMod = item.tem_mod && !item.tem_mpp && String(item.tipos_manut || '').trim() === 'MOD';
      const soMpp = item.tem_mpp && !item.tem_mod && !String(item.tipos_manut || '').split(',').some(t => {
        const s = t.trim();
        return s && !s.startsWith('MPP');
      });
      if (soMod && !incluirMod) continue;
      if (soMpp && !incluirMpp) continue;
      if (!item.tem_mod && !item.tem_mpp && !incluirOutros) continue;

      const hp = horasMes(m);
      const hdpRaw = Math.max(0, Number(item.hdp_programado) || 0);
      const hrdRaw = Math.max(0, Number(item.hrd_expurgado) || 0);
      const hdceRaw = Math.max(0, Number(item.hdce_expurgado) || 0);

      if (aplicarExpurgos) {
        const hdce = Number(Math.min(hp, hdceRaw).toFixed(2));
        const hrd = Number(Math.min(Math.max(0, hp - hdce), hrdRaw).toFixed(2));
        const hdp = Number(Math.min(Math.max(0, hp - hdce - hrd), hdpRaw).toFixed(2));
        const slot = {};
        if (hdp > 0) slot.HDP = hdp;
        if (hrd > 0) slot.HRD = hrd;
        if (hdce > 0) slot.HDCE = hdce;
        if (Object.keys(slot).length) {
          edicoes[`${m}|${item.ug}`] = slot;
        }
      } else {
        const bruto = Math.min(hp, hdpRaw + hrdRaw + hdceRaw);
        const hdp = Number(bruto.toFixed(2));
        if (hdp > 0) {
          edicoes[`${m}|${item.ug}`] = { HDP: hdp };
        }
      }
    }
    return edicoes;
  }

  /**
   * Calcula a margem (headroom) em horas-UG equivalentes (na potencia media da usina)
   * que a janela de 60 meses suporta antes de o ID cair abaixo do ID de referencia (FID < 1).
   */
  function calcularMargemHoras(dados, ceg, mesAlvo, edicoes = {}, idRef = undefined) {
    const usina = dados.usinas.find(u => u.cod_ceg === ceg);
    if (!usina) return null;
    if (idRef === undefined) idRef = usina.id_referencia;
    const ugs = dados.horas
      .filter(u => u.cod_ceg === ceg && mesDe(u.data) === dados.mes_base)
      .map(u => ({ ug: u.ug, potencia_mw: u.potencia_ug_mw }));
    if (!ugs.length) return null;
    const potMedia = ugs.reduce((s, u) => s + u.potencia_mw, 0) / ugs.length;
    const potTotal = ugs.reduce((s, u) => s + u.potencia_mw, 0);

    // Determina deslocamento do mesAlvo em relacao a mes_base
    const [a0, m0] = mesDe(dados.mes_base).split('-').map(Number);
    const [a1, m1] = mesDe(mesAlvo).split('-').map(Number);
    const horizonte = (a1 - a0) * 12 + (m1 - m0);
    if (horizonte < 0) return null;

    const serie = dados.mensal
      .filter(m => m.cod_ceg === ceg)
      .map(m => ({
        mes: mesDe(m.mes),
        valido: m.mes_valido,
        nf: m.numerador_teifa,
        df: m.denominador_teifa,
        np: m.numerador_teip,
        dp: m.denominador_teip,
      }));
    for (let i = 1; i <= horizonte; i++) {
      const m = moverMes(dados.mes_base, i);
      const hp = horasMes(m);
      let nf = 0, df = 0, np = 0, dp = 0;
      for (const ug of ugs) {
        const ent = edicoes[`${m}|${ug.ug}`] || {};
        const HDP = ent.HDP || 0, HDF = ent.HDF || 0, HEDP = ent.HEDP || 0,
          HEDF = ent.HEDF || 0, HRD = ent.HRD || 0, HDCE = ent.HDCE || 0;
        const hs = Math.max(0, hp - (HDP + HDF + HEDP + HEDF + HRD + HDCE));
        const p = ug.potencia_mw;
        nf += p * (HDF + HEDF);
        df += p * (HDF + HEDF + hs + HDCE + HRD);
        np += p * (HDP + HEDP);
        dp += p * hp;
      }
      serie.push({ mes: m, valido: true, nf, df, np, dp });
    }
    const inicio = moverMes(mesAlvo, -59);
    const janela = serie.filter(m => m.mes >= inicio && m.mes <= mesAlvo);
    if (janela.filter(m => m.valido).length !== 60) return null;
    const NF = janela.reduce((s, m) => s + (m.nf || 0), 0);
    const DF = janela.reduce((s, m) => s + (m.df || 0), 0);
    const NP = janela.reduce((s, m) => s + (m.np || 0), 0);
    const DP = janela.reduce((s, m) => s + (m.dp || 0), 0);
    if (DF <= 0 || DP <= 0) return null;

    const teifa = NF / DF;
    const teip = NP / DP;
    const idAtual = (1 - teifa) * (1 - teip);

    // 1) Margem em HDP (reduz HS e aumenta NP):
    // Ao trocar x MW*h de HS por HDP: NP' = NP + x, DF' = DF - x, NF' = NF, DP' = DP
    // Resolve exatamente via busca binaria ou formula quadratica; aqui formula exata:
    // (1 - NF/(DF - x)) * (1 - (NP + x)/DP) = idRef
    // Se idAtual >= idRef, x >= 0 (folga); se idAtual < idRef, x < 0 (deficit a recuperar).
    let margemMwhHdp = 0;
    if (Math.abs(idAtual - idRef) > 1e-12) {
      // f(x) = (1 - NF/(DF - x)) * (1 - (NP + x)/DP) - idRef  (decrescente em x)
      let lo = -NP, hi = Math.min(DF - NF - 1, DP - NP);
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        const val = (1 - NF / (DF - mid)) * (1 - (NP + mid) / DP);
        if (val > idRef) lo = mid; else hi = mid;
      }
      margemMwhHdp = (lo + hi) / 2;
    }

    // 2) Margem em HDF (troca HS por HDF -> DF nao muda, NF' = NF + x):
    // (1 - (NF + x)/DF) * (1 - teip) = idRef  =>  x = DF * (1 - idRef/(1 - teip)) - NF
    const teifaMax = 1 - idRef / Math.max(1e-9, 1 - teip);
    const margemMwhHdf = DF * teifaMax - NF;

    return {
      mes: mesAlvo,
      id_atual: idAtual,
      id_ref: idRef,
      fid_atual: idAtual / idRef,
      pot_media_mw: potMedia,
      pot_total_mw: potTotal,
      margem_horas_hdp_ug_media: margemMwhHdp / potMedia,
      margem_horas_hdf_ug_media: margemMwhHdf / potMedia,
      margem_dias_hdp_ug_media: margemMwhHdp / (potMedia * 24),
      margem_dias_hdf_ug_media: margemMwhHdf / (potMedia * 24),
    };
  }

  /**
   * Recalcula projecao das 5 faixas SIN com fatores TEIF/TEIP e exclusoes de sensibilidade.
   */
  function calcularProjecao2028(sinUsinas, ref2022PorFaixa, opcoes = {}) {
    const fatorTeif = Number(opcoes.fatorTeif ?? 1);
    const fatorTeip = Number(opcoes.fatorTeip ?? 1);
    const excluirPimental = Boolean(opcoes.excluirPimental);
    const excluirBeloMonte = Boolean(opcoes.excluirBeloMonte);
    const incluirItaipu = Boolean(opcoes.incluirItaipu);
    const overrides = opcoes.overrides || {};

    const faixas = [1, 2, 3, 4, 5].map(f => ({
      faixa: f,
      faixa_label: ref2022PorFaixa[f]?.faixa_label || `Faixa ${f}`,
      id_ref_2022_pct: ref2022PorFaixa[f]?.id_ref_2022_pct ?? 94.5,
      ugs_sin: 0,
      usinas_sin: 0,
      soma_teifa: 0,
      soma_teip: 0,
    }));

    for (const u of (sinUsinas || [])) {
      const elegivelTecnico =
        u.faixa >= 1 && u.faixa <= 5 && u.ugs > 0 && Number.isFinite(u.teifa_pct) && Number.isFinite(u.teip_pct);
      let ativa;
      if (Object.prototype.hasOwnProperty.call(overrides, u.id_sin)) {
        ativa = elegivelTecnico && Boolean(overrides[u.id_sin]);
      } else {
        ativa = Boolean(u.valida_calculo);
        if (incluirItaipu && u.id_sin === 'SIN83-GERAL' && elegivelTecnico) {
          ativa = true;
        }
        if (excluirPimental && u.id_sin === 'TAX165') ativa = false;
        if (excluirBeloMonte && u.id_sin === 'SIN76') ativa = false;
      }
      if (!ativa) continue;
      const slot = faixas[u.faixa - 1];
      if (!slot) continue;
      slot.ugs_sin += u.ugs;
      slot.usinas_sin += 1;
      slot.soma_teifa += u.ugs * u.teifa_pct * fatorTeif;
      slot.soma_teip += u.ugs * u.teip_pct * fatorTeip;
    }

    return faixas.map(s => {
      const teifa = s.ugs_sin > 0 ? Math.min(100, s.soma_teifa / s.ugs_sin) : null;
      const teip = s.ugs_sin > 0 ? Math.min(100, s.soma_teip / s.ugs_sin) : null;
      const id = teifa !== null && teip !== null ? 100 * (1 - teifa / 100) * (1 - teip / 100) : null;
      return {
        faixa: s.faixa,
        faixa_label: s.faixa_label,
        ugs_sin: s.ugs_sin,
        usinas_sin: s.usinas_sin,
        teifa_proj_pct: teifa,
        teip_proj_pct: teip,
        id_proj_2028_pct: id,
        id_ref_2022_pct: s.id_ref_2022_pct,
        delta_2028_2022_pp: id !== null ? id - s.id_ref_2022_pct : null,
      };
    });
  }

  root.MotorCTG = {
    CAMPOS,
    mesDe,
    moverMes,
    horasMes,
    indicadores,
    projetar,
    construirEdicoesPlano,
    calcularMargemHoras,
    calcularProjecao2028,
  };
  if (typeof module !== 'undefined') module.exports = root.MotorCTG;
})(globalThis);
