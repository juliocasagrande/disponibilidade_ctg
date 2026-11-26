(function () {
  'use strict';

  let D = JSON.parse(document.getElementById('dados-painel').textContent);
  const M = MotorCTG;
  const el = id => document.getElementById(id);
  const mes = M.mesDe;

  const numero = (v, casas = 3) =>
    v === null || v === undefined || !Number.isFinite(v)
      ? '—'
      : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const pct = (v, casas = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${numero(v * 100, casas)}%`);
  const pct100 = (v, casas = 3) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${numero(v, casas)}%`);
  const dataMes = v => {
    if (!v) return '—';
    const [a, m] = mes(v).split('-');
    return `${m}/${a}`;
  };
  const dataDia = v => {
    if (!v) return '—';
    const [a, m, d] = String(v).slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  };
  const esc = v =>
    String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CORES = {
    navy: '#06243d',
    blue: '#0066b3',
    cyan: '#00a8e8',
    green: '#00a859',
    teal: '#008b72',
    amber: '#e07a16',
    red: '#c9372c',
    slate: '#64748b',
    purple: '#6d5bd0',
  };

  const TIPO_COR = {
    MPP0: '#0066b3',
    MPP1: '#008b72',
    MPP2: '#00a8e8',
    MOD: '#c9372c',
    MPAIE: '#e07a16',
    PRED: '#6d5bd0',
    'C. PROG': '#b45309',
    CSEG: '#475569',
    BS: '#0284c7',
    CORR: '#991b1b',
    OUTROS: '#64748b',
  };

  const PAGE_META = {
    atual: ['DESEMPENHO OPERACIONAL', 'Situação Atual das Usinas', 'Visão Geral'],
    simulacao: ['SIMULAÇÃO & PLANEJAMENTO', 'Simulador de Cenários de ID & FID', 'Simulador FID'],
    manutencoes: ['PLANO PLURIANUAL', 'Paradas Programadas e Modernizações', 'Paradas Programadas'],
    projecao: ['REVISÃO QUINQUENAL SIN', 'Projeção ID Ref', 'Projeção ID Ref'],
    metodologia: ['CONFORMIDADE REGULATÓRIA', 'Metodologia Oficial ONS & Auditoria', 'Metodologia & ONS'],
    admin: ['ADMINISTRAÇÃO DO SISTEMA', 'Painel do Administrador', 'Administrador'],
  };

  function isMobileViewport() {
    return window.innerWidth <= 860;
  }
  function isNativeApp() {
    return Boolean(
      (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
      location.protocol === 'capacitor:' ||
      location.protocol === 'ionic:'
    );
  }
  function getApiBase() {
    try {
      const saved = (localStorage.getItem('ctg-api-base') || '').trim().replace(/\/+$/, '');
      if (saved) return saved;
    } catch (_) {}
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      if (isNativeApp()) return '';
      return '';
    }
    return '';
  }
  function apiUrl(path) {
    const base = getApiBase();
    return base ? `${base}${path}` : path;
  }
  function temServidorDisponivel() {
    if (getApiBase()) return true;
    return (location.protocol === 'http:' || location.protocol === 'https:') && !isNativeApp();
  }
  function hapticTap() {
    try {
      const cap = window.Capacitor;
      if (cap && cap.Plugins && cap.Plugins.Haptics) {
        cap.Plugins.Haptics.impact({ style: 'LIGHT' }).catch(() => {});
      }
    } catch (_) {}
  }

  const charts = {};
  const RESET_Y_ICON_PATH = 'path://M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z';

  function arredondarEscalaY(valor, span) {
    if (!Number.isFinite(valor)) return valor;
    const mag = Math.abs(span || 1);
    const casas = mag >= 100 ? 0 : mag >= 10 ? 1 : mag >= 1 ? 2 : mag >= 0.1 ? 3 : 4;
    return Number(valor.toFixed(casas));
  }

  function limitesEixoYComRef(refVal, margem, casas = 2, teto = null) {
    return {
      min: v => {
        const refMin = refVal - margem;
        const base = Number.isFinite(v.min) ? Math.min(v.min - margem * 0.2, refMin) : refMin;
        return Number(base.toFixed(casas));
      },
      max: v => {
        const refMax = refVal + margem;
        let topo = Number.isFinite(v.max) ? Math.max(v.max + margem * 0.2, refMax) : refMax;
        if (teto !== null && topo > teto && (!Number.isFinite(v.max) || v.max <= teto)) {
          topo = teto;
        }
        return Number(topo.toFixed(casas));
      },
    };
  }

  function anexarAjusteEixoY(instance, dom, origSetOption) {
    const estado = {
      habilitado: false,
      baseYAxis: null,
      arrastando: null,
      badgeTimer: null,
    };
    instance.__yScale = estado;

    function obterGeometriaY() {
      try {
        const model = instance.getModel();
        const gridComp = model?.getComponent('grid', 0);
        const yComp = model?.getComponent('yAxis', 0);
        const rect = gridComp?.coordinateSystem?.getRect();
        const extent = yComp?.axis?.scale?.getExtent();
        if (!rect || !extent || extent.length < 2) return null;
        if (!Number.isFinite(extent[0]) || !Number.isFinite(extent[1])) return null;
        return { rect, min: extent[0], max: extent[1] };
      } catch (_) {
        return null;
      }
    }

    function mostrarPillY(texto, fixo = false) {
      let pill = dom.querySelector('.chart-yscale-pill');
      if (!pill) {
        pill = document.createElement('div');
        pill.className = 'chart-yscale-pill';
        dom.appendChild(pill);
      }
      pill.textContent = texto;
      pill.classList.add('visivel');
      clearTimeout(estado.badgeTimer);
      if (!fixo) {
        estado.badgeTimer = setTimeout(() => pill.classList.remove('visivel'), 1500);
      }
    }

    function aplicarEscalaY(minVal, maxVal, fixo = true) {
      if (!Number.isFinite(minVal) || !Number.isFinite(maxVal) || maxVal <= minVal) return;
      const span = maxVal - minVal;
      const rMin = arredondarEscalaY(minVal, span);
      const rMax = arredondarEscalaY(maxVal, span);
      if (rMax <= rMin) return;
      origSetOption({ yAxis: { min: rMin, max: rMax } });
      const casas = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3;
      mostrarPillY(`Eixo Y: ${numero(rMin, casas)} a ${numero(rMax, casas)} · 2× clique p/ resetar`, fixo);
    }

    function resetarEscalaY() {
      if (!estado.habilitado || !estado.baseYAxis) return;
      const b = estado.baseYAxis;
      origSetOption({
        yAxis: {
          min: b.min !== undefined ? b.min : null,
          max: b.max !== undefined ? b.max : null,
          scale: b.scale !== undefined ? b.scale : false,
        },
      });
      mostrarPillY('Eixo Y restaurado para automático', false);
    }
    estado.resetar = resetarEscalaY;

    function estaNaFaixaY(ev) {
      if (!estado.habilitado) return null;
      const geo = obterGeometriaY();
      if (!geo) return null;
      const alvoBox = dom.querySelector('canvas') || dom;
      const box = alvoBox.getBoundingClientRect();
      const relX = ev.clientX - box.left;
      const relY = ev.clientY - box.top;
      const { rect } = geo;
      if (relX >= -6 && relX <= rect.x + 12 && relY >= rect.y - 12 && relY <= rect.y + rect.height + 12) {
        const ratio = Math.max(0, Math.min(1, (relY - rect.y) / Math.max(1, rect.height)));
        return { geo, ratio };
      }
      return null;
    }

    const onPointerMove = ev => {
      if (estado.arrastando) {
        ev.preventDefault();
        const { startY, min0, max0, span0, height, mode } = estado.arrastando;
        const dy = ev.clientY - startY;
        const minSpan = Math.max(1e-4, span0 * 0.02);
        let novoMin = min0;
        let novoMax = max0;

        if (mode === 'pan' || ev.shiftKey) {
          const delta = (dy / Math.max(40, height)) * span0;
          novoMin = min0 + delta;
          novoMax = max0 + delta;
        } else if (mode === 'max') {
          const fator = Math.exp((dy / Math.max(40, height)) * 2.2);
          novoMax = min0 + Math.max(minSpan, span0 * fator);
        } else if (mode === 'min') {
          const fator = Math.exp((-dy / Math.max(40, height)) * 2.2);
          novoMin = max0 - Math.max(minSpan, span0 * fator);
        } else {
          const fator = Math.exp((dy / Math.max(40, height)) * 2.4);
          const meio = (min0 + max0) / 2;
          const meiaLarg = Math.max(minSpan / 2, (span0 / 2) * fator);
          novoMin = meio - meiaLarg;
          novoMax = meio + meiaLarg;
        }
        aplicarEscalaY(novoMin, novoMax, true);
        return;
      }
      const hit = estaNaFaixaY(ev);
      if (hit) {
        dom.classList.add('chart-yscale-hover');
      } else {
        dom.classList.remove('chart-yscale-hover');
      }
    };

    const onPointerDown = ev => {
      if (ev.button !== 0) return;
      const hit = estaNaFaixaY(ev);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      const { geo, ratio } = hit;
      const span0 = Math.max(1e-6, geo.max - geo.min);
      const mode = ev.shiftKey ? 'pan' : ratio < 0.28 ? 'max' : ratio > 0.72 ? 'min' : 'scale';
      estado.arrastando = {
        pointerId: ev.pointerId,
        startY: ev.clientY,
        min0: geo.min,
        max0: geo.max,
        span0,
        height: geo.rect.height,
        mode,
      };
      dom.classList.add('chart-yscale-dragging');
      try { dom.setPointerCapture(ev.pointerId); } catch (_) {}
    };

    const encerrarArraste = ev => {
      if (!estado.arrastando) return;
      const pid = estado.arrastando.pointerId;
      estado.arrastando = null;
      dom.classList.remove('chart-yscale-dragging');
      try { dom.releasePointerCapture(pid); } catch (_) {}
      const pill = dom.querySelector('.chart-yscale-pill');
      if (pill) {
        clearTimeout(estado.badgeTimer);
        estado.badgeTimer = setTimeout(() => pill.classList.remove('visivel'), 1500);
      }
    };

    const onDblClick = ev => {
      const hit = estaNaFaixaY(ev);
      if (!hit) return;
      ev.preventDefault();
      resetarEscalaY();
    };

    const onWheel = ev => {
      const hit = estaNaFaixaY(ev);
      if (!hit) return;
      ev.preventDefault();
      const { geo } = hit;
      const span0 = Math.max(1e-6, geo.max - geo.min);
      const meio = (geo.min + geo.max) / 2;
      const fator = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      const meiaLarg = Math.max(1e-4, (span0 / 2) * fator);
      aplicarEscalaY(meio - meiaLarg, meio + meiaLarg, false);
    };

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', encerrarArraste);
    dom.addEventListener('pointercancel', encerrarArraste);
    dom.addEventListener('dblclick', onDblClick);
    dom.addEventListener('wheel', onWheel, { passive: false });

    instance.__cleanupYScale = () => {
      clearTimeout(estado.badgeTimer);
      dom.classList.remove('chart-yscale-hover', 'chart-yscale-dragging');
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', encerrarArraste);
      dom.removeEventListener('pointercancel', encerrarArraste);
      dom.removeEventListener('dblclick', onDblClick);
      dom.removeEventListener('wheel', onWheel);
    };
  }

  function getChart(id) {
    const dom = el(id);
    if (!dom || typeof echarts === 'undefined') return null;
    if (charts[id] && charts[id].getDom() !== dom) {
      if (charts[id].__cleanupYScale) charts[id].__cleanupYScale();
      charts[id].dispose();
      delete charts[id];
    }
    if (!charts[id]) {
      const instance = echarts.init(dom, null, { renderer: 'canvas' });
      const origSetOption = instance.setOption.bind(instance);
      anexarAjusteEixoY(instance, dom, origSetOption);
      instance.setOption = (option, ...rest) => {
        if (option && typeof option === 'object') {
          const tip = option.tooltip && typeof option.tooltip === 'object' ? option.tooltip : {};
          const mob = isMobileViewport();
          const yCfg = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
          const temEixoYNumerico = Boolean(yCfg && (!yCfg.type || yCfg.type === 'value'));
          if (instance.__yScale) {
            instance.__yScale.habilitado = temEixoYNumerico;
            instance.__yScale.baseYAxis = temEixoYNumerico
              ? { min: yCfg.min, max: yCfg.max, scale: yCfg.scale }
              : null;
          }

          let toolbox = option.toolbox;
          if (toolbox && typeof toolbox === 'object') {
            const feat = { ...(toolbox.feature || {}) };
            if (feat.saveAsImage) {
              feat.saveAsImage = {
                backgroundColor: '#ffffff',
                pixelRatio: 2,
                ...feat.saveAsImage,
              };
            }
            if (temEixoYNumerico && !feat.myResetY) {
              feat.myResetY = {
                show: true,
                title: 'Restaurar escala Y',
                icon: RESET_Y_ICON_PATH,
                onclick: () => instance.__yScale?.resetar?.(),
              };
            }
            toolbox = { ...toolbox, feature: feat };
          }

          const next = {
            ...option,
            toolbox,
            tooltip: {
              appendToBody: !mob,
              confine: mob,
              extraCssText: `z-index: 9999; box-shadow: 0 8px 24px rgba(6,36,61,0.16); border-radius: 8px; max-width: ${mob ? '270px' : '360px'}; white-space: normal;`,
              ...tip,
            },
          };
          if (mob) {
            if (next.toolbox) next.toolbox = { ...next.toolbox, show: false };
            if (next.legend && typeof next.legend === 'object' && !Array.isArray(next.legend)) {
              next.legend = {
                ...next.legend,
                type: 'scroll',
                top: 2,
                left: 6,
                right: 6,
                itemWidth: 14,
                itemHeight: 9,
                itemGap: 10,
                textStyle: { ...(next.legend.textStyle || {}), fontSize: 11 },
              };
            }
            if (next.grid && typeof next.grid === 'object' && !Array.isArray(next.grid)) {
              const gTop = typeof next.grid.top === 'number' ? Math.max(next.grid.top, 42) : next.grid.top;
              next.grid = { ...next.grid, top: gTop ?? 42, left: next.grid.left ?? 10, right: next.grid.right ?? 12, containLabel: true };
            }
          }
          option = next;
        }
        return origSetOption(option, ...rest);
      };
      charts[id] = instance;
    }
    return charts[id];
  }
  function clearChart(id, msg) {
    if (charts[id]) {
      if (charts[id].__cleanupYScale) charts[id].__cleanupYScale();
      charts[id].dispose();
      delete charts[id];
    }
    el(id).innerHTML = `<div class="empty-state">${esc(msg)}</div>`;
  }
  function resizeCharts() {
    for (const c of Object.values(charts)) {
      try { c.resize(); } catch (_) {}
    }
  }
  window.addEventListener('resize', () => requestAnimationFrame(resizeCharts));

  function tabela(id, titulos, linhas, rowAttrs = null) {
    const head = `<thead><tr>${titulos.map(t => `<th scope="col">${esc(t)}</th>`).join('')}</tr></thead>`;
    const body = linhas.length
      ? linhas
          .map((l, idx) => {
            if (l && l.__group) {
              return `<tr class="group-row"><td colspan="${titulos.length}">${esc(l.__group)}</td></tr>`;
            }
            const attr = rowAttrs ? rowAttrs(idx) : '';
            return `<tr ${attr}>${l.map(v => (typeof v === 'object' && v && 'html' in v ? `<td class="${v.cls || ''}">${v.html}</td>` : `<td>${v}</td>`)).join('')}</tr>`;
          })
          .join('')
      : `<tr><td colspan="${titulos.length}" style="text-align:center;padding:28px;color:#64748b">Nenhum registro encontrado para os filtros selecionados.</td></tr>`;
    el(id).innerHTML = `${head}<tbody>${body}</tbody>`;
  }

  function renderKpis(id, itens) {
    el(id).innerHTML = itens
      .map(
        ([titulo, valor, nota, tom = '']) =>
          `<div class="kpi ${tom}"><label>${esc(titulo)}</label><strong>${esc(valor)}</strong><small>${esc(nota)}</small></div>`
      )
      .join('');
  }

  // ===== ESTADO GLOBAL E LOCALSTORAGE =====
  let pagina = 'atual';
  let metricaAtual = 'id';
  let metricaSim = 'id';
  let ultimoCenario = null;
  let adminAutenticado = false;
  let jobTimer = null;
  let pqAtual = null;
  let pqOffset = 0;
  let sinOverrides = {};

  function chaveStorage() {
    return `ctg-cenarios-v3-${D.mes_base}`;
  }
  let salvo = {};
  function carregarSalvo() {
    try { salvo = JSON.parse(localStorage.getItem(chaveStorage()) || '{}'); } catch (_) { salvo = {}; }
  }
  function guardar() {
    try { localStorage.setItem(chaveStorage(), JSON.stringify(salvo)); } catch (_) {}
  }
  carregarSalvo();

  function usinasFiltradas() {
    const polo = el('polo').value;
    const ceg = el('usina').value;
    return D.usinas.filter(u => (!polo || u.polo === polo) && (!ceg || u.cod_ceg === ceg));
  }
  function usinaAtual() {
    return D.usinas.find(u => u.cod_ceg === el('usina').value) || null;
  }

  function estadoSim(ceg) {
    const u = D.usinas.find(x => x.cod_ceg === ceg);
    if (!u) return null;
    if (!salvo[ceg]) {
      const horizonte = 24;
      salvo[ceg] = {
        edicoes: M.construirEdicoesPlano(D, ceg, horizonte, { aplicarExpurgos: true }),
        idRef: u.id_referencia,
        horizonte,
        aplicarExpurgos: true,
        iniciadoComPlano: true,
        baseModo: 'plano',
        simuladas: [],
      };
      guardar();
    }
    if (salvo[ceg].aplicarExpurgos === undefined) salvo[ceg].aplicarExpurgos = true;
    if (!Array.isArray(salvo[ceg].simuladas)) salvo[ceg].simuladas = [];
    if (!salvo[ceg].baseModo) salvo[ceg].baseModo = 'plano';
    return salvo[ceg];
  }

  function badgeClassificador(cls, grupoOns) {
    const sig = (cls || '').trim().toUpperCase();
    if (!sig) return '<span class="badge neutral" title="Sem classificador ONS (tratado como HDP)">—</span>';
    if (grupoOns === '7.1.3.1') return `<span class="badge warn" title="ONS 7.1.3.1 · Considerada em TEIFa/TEIP">${esc(sig)}</span>`;
    if (grupoOns === '7.1.3.2') return `<span class="badge" title="ONS 7.1.3.2 · Expurgada → HRD">${esc(sig)}</span>`;
    if (grupoOns === '7.1.3.3') return `<span class="badge info" title="ONS 7.1.3.3 · Externa/Expurgada → HDCE">${esc(sig)}</span>`;
    return `<span class="badge neutral">${esc(sig)}</span>`;
  }

  function rotuloOrigemExpurgo(origem) {
    if (origem === 'CLASSIFICADOR_ONS') return 'Expurgo automático via Classificador ONS (RO-AO.BR.04)';
    if (origem === 'PLANILHA_MISTA') return 'Expurgo parcial informado na planilha (parada mista em GUM)';
    if (origem === 'PLANILHA') return 'Expurgo informado na planilha (validado no teto bruto)';
    return 'Sem expurgo';
  }

  function badgeStatusOns(r) {
    if (!r.janela_completa) return '<span class="badge neutral">Histórico incompleto</span>';
    const div = D.conciliacao.some(
      c => c.cod_ceg === r.cod_ceg && mes(c.mes_fim_historico) === mes(r.mes_fim_historico) && c.status === 'DIVERGENCIA'
    );
    if (!div && r.meses_com_ressalva > 0) return '<span class="badge warn">Conciliado c/ ressalva</span>';
    return div ? '<span class="badge warn">Conferir com ONS</span>' : '<span class="badge">Conciliado ONS</span>';
  }

  function badgeFid(fid) {
    if (fid === null || fid === undefined || !Number.isFinite(fid)) return '<span class="badge neutral">—</span>';
    if (fid >= 1) return `<span class="badge">${numero(fid, 4)}</span>`;
    if (fid >= 0.99) return `<span class="badge warn">${numero(fid, 4)}</span>`;
    return `<span class="badge danger">${numero(fid, 4)}</span>`;
  }

  // ===== POPULAR FILTROS GLOBAIS =====
  function popularFiltrosGlobais() {
    const poloSel = el('polo').value;
    const polos = [...new Set(D.usinas.map(u => u.polo).filter(Boolean))].sort();
    el('polo').innerHTML = '<option value="">Todos os polos</option>' + polos.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    if (polos.includes(poloSel)) el('polo').value = poloSel;
    popularSelectUsinas();

    const mesAtualAnt = el('mes-atual').value;
    const meses = [...new Set(D.mensal.map(r => mes(r.mes)))].sort().reverse();
    el('mes-atual').innerHTML = meses.map(m => `<option value="${m}">${dataMes(m)}</option>`).join('');
    if (meses.includes(mesAtualAnt)) el('mes-atual').value = mesAtualAnt;

    el('base').textContent = `Base ONS: ${dataMes(D.mes_base)}`;

    if (el('proj-mes-corte')) {
      const corteAnt = el('proj-mes-corte').value;
      const mesesSin = (D.sin_meses && D.sin_meses.length) ? D.sin_meses : [D.mes_base];
      el('proj-mes-corte').innerHTML = mesesSin.map(m => `<option value="${m}">${dataMes(m)}</option>`).join('');
      if (mesesSin.includes(corteAnt)) el('proj-mes-corte').value = corteAnt;
    }

    // Filtros pagina manutencoes
    const anos = [...new Set((D.manutencoes || []).map(m => m.ano_inicio).filter(Boolean))].sort((a, b) => a - b);
    const anoSel = el('manut-ano').value;
    el('manut-ano').innerHTML =
      '<option value="">Todos os anos</option>' + anos.map(a => `<option value="${a}">${a}</option>`).join('');
    const anoPadrao = anos.includes(2026) ? '2026' : (anos[0] ? String(anos[0]) : '');
    el('manut-ano').value = anos.map(String).includes(anoSel) ? anoSel : anoPadrao;

    const tipos = [...new Set((D.manutencoes || []).map(m => m.tipo_manut).filter(Boolean))].sort();
    el('manut-tipo').innerHTML = '<option value="">Todos os tipos</option>' + tipos.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');

    const clsSel = el('manut-classificador')?.value || '';
    const classifs = [...new Set((D.manutencoes || []).map(m => m.classificador || 'SEM_CLASS'))].sort((a, b) => {
      if (a === 'SEM_CLASS') return 1;
      if (b === 'SEM_CLASS') return -1;
      return a.localeCompare(b);
    });
    if (el('manut-classificador')) {
      el('manut-classificador').innerHTML =
        '<option value="">Todos os classificadores</option>' +
        classifs.map(c => `<option value="${esc(c)}">${c === 'SEM_CLASS' ? 'Sem classificador' : esc(c)}</option>`).join('');
      if (classifs.includes(clsSel)) el('manut-classificador').value = clsSel;
    }
  }

  function popularSelectUsinas() {
    const polo = el('polo').value;
    const atual = el('usina').value;
    const lista = D.usinas.filter(u => !polo || u.polo === polo);
    el('usina').innerHTML =
      '<option value="">Todas as usinas (' + lista.length + ')</option>' +
      lista.map(u => `<option value="${esc(u.cod_ceg)}">${esc(u.usina)}</option>`).join('');
    if (lista.some(u => u.cod_ceg === atual)) el('usina').value = atual;
  }

  function renderContextoFiltro(prefixo) {
    const bar = el(`contexto-${prefixo}`);
    if (!bar) return;
    const polo = el('polo').value;
    const uUnica = usinaAtual();
    if (!polo && !uUnica) {
      bar.hidden = true;
      return;
    }
    const titulo = el(`contexto-${prefixo}-titulo`);
    const sub = el(`contexto-${prefixo}-sub`);
    const btnSim = el(`btn-${prefixo}-simular`);

    if (uUnica) {
      const ugs = (D.ugs || []).filter(g => g.cod_ceg === uUnica.cod_ceg);
      const pot = ugs.reduce((s, g) => s + (g.potencia_mw || 0), 0);
      titulo.textContent = `${uUnica.usina} · ${uUnica.polo} (Faixa ${uUnica.faixa})`;
      sub.textContent =
        `MME 709/2022 vigente desde ${dataMes(uUnica.inicio_vigencia)} · TEIF ref.: ${pct(uUnica.teif_referencia)} · IP ref.: ${pct(uUnica.ip_referencia)} · ${ugs.length} UGs (${numero(pot, 1)} MW)`;
      if (btnSim) btnSim.hidden = false;
    } else {
      const uPolo = D.usinas.filter(u => u.polo === polo);
      const cegs = new Set(uPolo.map(u => u.cod_ceg));
      const ugs = (D.ugs || []).filter(g => cegs.has(g.cod_ceg));
      const pot = ugs.reduce((s, g) => s + (g.potencia_mw || 0), 0);
      titulo.textContent = `${polo} · ${uPolo.length} UHE${uPolo.length === 1 ? '' : 's'}`;
      sub.textContent =
        `Usinas: ${uPolo.map(u => u.usina).join(', ')} · ${ugs.length} UGs (${numero(pot, 1)} MW)`;
      if (btnSim) btnSim.hidden = true;
    }
    bar.hidden = false;
  }

  function limparFiltroPoloUsina() {
    el('polo').value = '';
    el('usina').value = '';
    popularSelectUsinas();
    renderPaginaAtual();
    atualizarUiMobile();
  }

  // ==================== 1. VISÃO GERAL (ATUAL) ====================
  function renderAtual() {
    renderContextoFiltro('atual');
    const m = el('mes-atual').value;
    const uList = usinasFiltradas();
    const cegs = new Set(uList.map(u => u.cod_ceg));
    const linhas = D.acumulado.filter(r => mes(r.mes_fim_historico) === m && cegs.has(r.cod_ceg));
    const unidades = D.horas.filter(r => mes(r.data) === m && cegs.has(r.cod_ceg));
    const uUnica = usinaAtual();
    const ultimo = uUnica ? linhas[0] : null;

    el('periodo-atual').textContent = `Histórico 60m: ${dataMes(M.moverMes(m, -59))} a ${dataMes(m)} · Referência contábil: ${dataMes(M.moverMes(m, 1))}`;

    if (uUnica && ultimo) {
      const tomFid = ultimo.fid_bruto !== null && ultimo.fid_bruto < 1 ? 'red' : 'green';
      renderKpis('kpis-atual', [
        ['ID Verificado (60m)', pct(ultimo.id_verificado), `Referência MME: ${pct(ultimo.id_referencia)}`, ultimo.fid_bruto < 1 ? 'red' : 'green'],
        ['FID Bruto / MRA', numero(ultimo.fid_bruto, 5), `FID MRA aplicado: ${numero(ultimo.fid_mra, 5)}`, tomFid],
        ['TEIFa · 60 meses', pct(ultimo.teifa), `Ref. MME: ${pct(uUnica.teif_referencia)}`, ''],
        ['TEIP · 60 meses', pct(ultimo.teip), `Ref. MME: ${pct(uUnica.ip_referencia)} · ${uUnica.polo}`, 'amber'],
      ]);
    } else {
      const potTotal = unidades.reduce((s, v) => s + (v.potencia_ug_mw || 0), 0);
      const validas = linhas.filter(r => r.id_verificado !== null);
      const idMedio = validas.length ? validas.reduce((s, r) => s + r.id_verificado, 0) / validas.length : null;
      const emRisco = linhas.filter(r => r.fid_bruto !== null && r.fid_bruto < 1);
      renderKpis('kpis-atual', [
        ['ID Médio das Usinas', pct(idMedio), `${validas.length} de ${linhas.length} janelas completas (60m)`, 'green'],
        ['Usinas com FID < 1', String(emRisco.length), emRisco.length ? emRisco.map(r => r.usina).join(', ') : 'Todas acima da referência MME', emRisco.length ? 'red' : 'green'],
        ['Escopo Selecionado', `${linhas.length} UHEs`, `${unidades.length} unidades geradoras monitoradas`, ''],
        ['Potência Efetiva', `${numero(potTotal, 1)} MW`, 'Base oficial ONS / cadastro CTG Brasil', ''],
      ]);
    }

    renderGraficoAtual(linhas, uUnica, m);

    const ordenadas = [...linhas].sort((a, b) => (a.fid_bruto ?? 9) - (b.fid_bruto ?? 9));
    tabela(
      'tabela-atual',
      ['Usina', 'Polo', 'TEIFa (%)', 'TEIP (%)', 'ID Verif. (%)', 'ID Ref. (%)', 'FID Bruto', 'FID MRA', 'Conciliação'],
      ordenadas.map(r => {
        const meta = D.usinas.find(u => u.cod_ceg === r.cod_ceg);
        return [
          `<strong>${esc(r.usina)}</strong>`,
          esc(meta?.polo || '—'),
          numero(r.teifa === null ? null : r.teifa * 100),
          numero(r.teip === null ? null : r.teip * 100),
          `<strong>${numero(r.id_verificado === null ? null : r.id_verificado * 100)}</strong>`,
          numero(r.id_referencia === null ? null : r.id_referencia * 100),
          badgeFid(r.fid_bruto),
          numero(r.fid_mra, 4),
          badgeStatusOns(r),
        ];
      }),
      idx => `class="clickable" data-ceg="${esc(ordenadas[idx].cod_ceg)}" title="Clique para filtrar ${esc(ordenadas[idx].usina)}"`
    );

    const contagemHoras = el('horas-contagem');
    if (contagemHoras) {
      contagemHoras.textContent = `${unidades.length} UG${unidades.length === 1 ? '' : 's'}`;
    }

    tabela(
      'tabela-horas',
      ['Usina', 'UG', 'Potência (MW)', 'HP', 'HDP', 'HDF', 'HEDP', 'HEDF', 'HS', 'HRD', 'HDCE', 'Saldo (h)', 'Qualidade'],
      unidades.map(r => [
        esc(r.nome_usina),
        `UG ${r.ug}`,
        numero(r.potencia_ug_mw, 2),
        ...['HP', 'HDP', 'HDF', 'HEDP', 'HEDF', 'HS', 'HRD', 'HDCE'].map(c => numero(r[c], 2)),
        numero(r.saldo_horas, 2),
        `<span class="badge ${!r.valido || r.ressalva_fechamento ? 'warn' : ''}" title="${esc(r.motivo_ressalva)}">${!r.valido ? 'Conferir' : r.ressalva_fechamento ? 'Ressalva' : 'Válido'}</span>`,
      ])
    );
  }

  function renderGraficoAtual(linhas, uUnica, mesSel) {
    if (uUnica) {
      el('titulo-grafico-atual').textContent = `Evolução Histórica (60m) · ${uUnica.usina}`;
      const hist = D.acumulado.filter(r => r.cod_ceg === uUnica.cod_ceg && mes(r.mes_fim_historico) <= mesSel && r.janela_completa);
      if (!hist.length) {
        clearChart('grafico-atual', 'Ainda não há janela completa de 60 meses neste período.');
        return;
      }
      const chart = getChart('grafico-atual');
      const labels = hist.map(r => dataMes(r.mes_fim_historico));
      let series = [];
      let yAxis = { type: 'value', axisLabel: { formatter: '{value}%' } };

      if (metricaAtual === 'id') {
        const refPct = Number((uUnica.id_referencia * 100).toFixed(3));
        series = [
          {
            name: 'ID Verificado (%)',
            type: 'line',
            smooth: 0.25,
            symbolSize: 6,
            data: hist.map(r => Number((r.id_verificado * 100).toFixed(4))),
            itemStyle: { color: CORES.blue },
            areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(0,102,179,0.22)' }, { offset: 1, color: 'rgba(0,102,179,0.01)' }]) },
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: CORES.amber, type: 'dashed', width: 2 },
              label: { formatter: `Ref. MME: ${numero(refPct, 2)}%`, position: 'insideEndTop', color: CORES.amber, fontWeight: 600 },
              data: [{ yAxis: refPct }],
            },
          },
        ];
        Object.assign(yAxis, { scale: true }, limitesEixoYComRef(refPct, 0.5, 2, 100));
      } else if (metricaAtual === 'fid') {
        series = [
          {
            name: 'FID Bruto',
            type: 'line',
            smooth: 0.25,
            data: hist.map(r => Number((r.fid_bruto ?? 0).toFixed(5))),
            itemStyle: { color: CORES.teal },
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: CORES.red, type: 'dashed', width: 2 },
              label: { formatter: 'Limite MRA: 1,000', position: 'insideEndTop', color: CORES.red },
              data: [{ yAxis: 1 }],
            },
          },
          {
            name: 'FID MRA',
            type: 'line',
            smooth: 0.25,
            lineStyle: { type: 'dotted', width: 2 },
            data: hist.map(r => Number((r.fid_mra ?? 0).toFixed(5))),
            itemStyle: { color: CORES.navy },
          },
        ];
        yAxis = { type: 'value', scale: true, ...limitesEixoYComRef(1, 0.005, 4) };
      } else {
        series = [
          { name: 'TEIFa (%)', type: 'line', smooth: 0.25, data: hist.map(r => Number((r.teifa * 100).toFixed(4))), itemStyle: { color: CORES.red } },
          { name: 'TEIP (%)', type: 'line', smooth: 0.25, data: hist.map(r => Number((r.teip * 100).toFixed(4))), itemStyle: { color: CORES.amber } },
        ];
        yAxis.scale = false;
      }

      chart.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: params => {
            const itens = Array.isArray(params) ? params : [params];
            const cab = `<strong>${esc(uUnica.usina)} · ${esc(itens[0]?.axisValue || '')}</strong>`;
            const linhasHtml = itens
              .map(p => `${p.marker} ${esc(p.seriesName)}: <strong>${metricaAtual === 'fid' ? numero(p.value, 5) : `${numero(p.value, 3)}%`}</strong>`)
              .join('<br/>');
            const notaJupia =
              uUnica.cod_ceg === 'UHE.PH.SP.001282-3.01' && metricaAtual !== 'taxas'
                ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#475569;line-height:1.35"><strong>Ref. específica (Portaria MME 709/2022):</strong> Jupiá utiliza TEIF/IP individuais (3,190% / 5,923% → 91,076%), diferentes do padrão da Faixa 3 (94,761%).</div>'
                : '';
            return `${cab}<br/>${linhasHtml}${notaJupia}`;
          },
        },
        legend: { top: 4, textStyle: { color: '#3c566b' } },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
        grid: { left: 56, right: 24, top: 44, bottom: 48 },
        xAxis: { type: 'category', data: labels, axisLabel: { color: '#5a7184' } },
        yAxis,
        dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
        series,
      }, true);
      return;
    }

    // Visao multi-usinas
    el('titulo-grafico-atual').textContent =
      metricaAtual === 'id'
        ? 'ID Verificado vs. Referência MME por Usina'
        : metricaAtual === 'fid'
        ? 'Fator de Indisponibilidade (FID Bruto) por Usina'
        : 'Composição das Taxas TEIFa × TEIP (60 meses)';
    const validas = linhas.filter(r => r.id_verificado !== null);
    if (!validas.length) {
      clearChart('grafico-atual', 'Sem janelas completas de 60 meses para o mês selecionado.');
      return;
    }
    const ord = [...validas].sort((a, b) => (a.fid_bruto ?? 0) - (b.fid_bruto ?? 0));
    const names = ord.map(r => r.usina);
    const chart = getChart('grafico-atual');

    let option;
    const tooltipMulti = (unidade, casas) => ({
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: params => {
        const itens = Array.isArray(params) ? params : [params];
        const idx = itens[0]?.dataIndex;
        const r = ord[idx];
        const cab = `<strong>${esc(r?.usina || itens[0]?.axisValue || '')}</strong>`;
        const linhasHtml = itens
          .map(p => {
            const val = typeof p.value === 'object' && p.value !== null ? p.value.value : p.value;
            return `${p.marker} ${esc(p.seriesName)}: <strong>${numero(val, casas)}${unidade}</strong>`;
          })
          .join('<br/>');
        const notaJupia =
          r?.cod_ceg === 'UHE.PH.SP.001282-3.01' && metricaAtual !== 'taxas'
            ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#475569;line-height:1.35"><strong>Ref. específica (Portaria MME 709/2022):</strong> Jupiá utiliza TEIF/IP individuais (3,190% / 5,923% → 91,076%), diferentes do padrão da Faixa 3 (94,761%).</div>'
            : '';
        return `${cab}<br/>${linhasHtml}${notaJupia}`;
      },
    });
    if (metricaAtual === 'id') {
      option = {
        tooltip: tooltipMulti('%', 3),
        legend: { top: 4 },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
        grid: { left: 56, right: 22, top: 44, bottom: 54 },
        xAxis: { type: 'category', data: names, axisLabel: { rotate: 22, color: '#3c566b', fontSize: 11 } },
        yAxis: {
          type: 'value',
          min: v => Math.max(80, Math.floor(v.min - 2)),
          max: 100,
          axisLabel: { formatter: '{value}%' },
        },
        series: [
          {
            name: 'ID Verificado (%)',
            type: 'bar',
            barMaxWidth: 34,
            data: ord.map(r => ({
              value: Number((r.id_verificado * 100).toFixed(3)),
              itemStyle: { color: r.fid_bruto < 1 ? CORES.red : CORES.blue, borderRadius: [5, 5, 0, 0] },
            })),
          },
          {
            name: 'ID Referência MME (%)',
            type: 'scatter',
            symbol: 'rect',
            symbolSize: [28, 4],
            z: 5,
            itemStyle: { color: CORES.amber },
            data: ord.map(r => Number((r.id_referencia * 100).toFixed(3))),
          },
        ],
      };
    } else if (metricaAtual === 'fid') {
      option = {
        tooltip: tooltipMulti('', 4),
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
        grid: { left: 56, right: 24, top: 36, bottom: 54 },
        xAxis: { type: 'category', data: names, axisLabel: { rotate: 22, color: '#3c566b', fontSize: 11 } },
        yAxis: { type: 'value', scale: true, ...limitesEixoYComRef(1, 0.005, 4) },
        series: [
          {
            name: 'FID Bruto',
            type: 'bar',
            barMaxWidth: 34,
            data: ord.map(r => ({
              value: Number(r.fid_bruto.toFixed(4)),
              itemStyle: { color: r.fid_bruto < 1 ? CORES.red : CORES.green, borderRadius: [5, 5, 0, 0] },
            })),
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: CORES.navy, type: 'dashed', width: 2 },
              label: { formatter: 'FID = 1,000', position: 'insideEndTop' },
              data: [{ yAxis: 1 }],
            },
          },
        ],
      };
    } else {
      option = {
        tooltip: tooltipMulti('%', 3),
        legend: { top: 4 },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
        grid: { left: 56, right: 24, top: 44, bottom: 54 },
        xAxis: { type: 'category', data: names, axisLabel: { rotate: 22, color: '#3c566b', fontSize: 11 } },
        yAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
        series: [
          { name: 'TEIFa (%)', type: 'bar', stack: 't', barMaxWidth: 34, itemStyle: { color: CORES.red }, data: ord.map(r => Number((r.teifa * 100).toFixed(3))) },
          { name: 'TEIP (%)', type: 'bar', stack: 't', barMaxWidth: 34, itemStyle: { color: CORES.amber, borderRadius: [4, 4, 0, 0] }, data: ord.map(r => Number((r.teip * 100).toFixed(3))) },
        ],
      };
    }

    chart.setOption(option, true);
    chart.off('click');
    chart.on('click', params => {
      const alvo = ord[params.dataIndex];
      if (alvo) {
        el('usina').value = alvo.cod_ceg;
        renderAtual();
      }
    });
  }

  // ==================== 2. SIMULADOR FID ====================
  function configurarSimulacao() {
    const u = usinaAtual();
    el('escolha-usina').hidden = !!u;
    el('conteudo-simulacao').hidden = !u;
    if (!u) return;

    const e = estadoSim(u.cod_ceg);
    el('horizonte').value = e.horizonte;
    el('id-referencia').value = Number((e.idRef * 100).toFixed(4));
    if (el('chk-sim-expurgo')) el('chk-sim-expurgo').checked = e.aplicarExpurgos !== false;
    el('nome-cenario').textContent = `${u.usina} · ${u.polo} (Faixa ${u.faixa})`;
    el('referencia-fonte').textContent =
      `MME 709/2022 vigente desde ${dataMes(u.inicio_vigencia)} · TEIF ref.: ${pct(u.teif_referencia)} · IP ref.: ${pct(u.ip_referencia)}`;

    const mesesOpts = Array.from({ length: e.horizonte }, (_, i) => {
      const m = M.moverMes(D.mes_base, i + 1);
      return `<option value="${m}">${dataMes(m)}</option>`;
    }).join('');
    const ant = el('mes-edicao').value;
    el('mes-edicao').innerHTML = mesesOpts;
    if ([...el('mes-edicao').options].some(o => o.value === ant)) el('mes-edicao').value = ant;

    el('estado-salvar').textContent =
      location.protocol === 'file:'
        ? 'Para gravar cenários em Parquet, execute: python scripts/executar.py --painel'
        : '';

    renderTabelaSimuladas();
    atualizarBadgeCenariosSalvos();
    renderEditor();
    renderSimulacao();
  }

  function renderEditor() {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    const m = el('mes-edicao').value;
    const hp = M.horasMes(m);
    const ugs = D.horas.filter(r => r.cod_ceg === u.cod_ceg && mes(r.data) === D.mes_base);

    // Paradas programadas do plano neste mes
    const paradasMes = (D.manutencoes_mensal || []).filter(p => p.cod_ceg === u.cod_ceg && mes(p.mes) === m);
    const mapaPlano = new Map(paradasMes.map(p => [p.ug, p]));

    if (paradasMes.length) {
      el('paradas-mes-resumo').hidden = false;
      el('paradas-mes-resumo').innerHTML =
        `<strong>Plano plurianual (${dataMes(m)}):</strong> ` +
        paradasMes
          .map(p => {
            const expH = (p.hrd_expurgado || 0) + (p.hdce_expurgado || 0);
            const detExp = expH > 0 ? ` · Expurgo ONS: <strong>${numero(expH, 1)} h</strong>` : '';
            return `UG ${p.ug}: HDP <strong>${numero(p.hdp_programado, 1)} h</strong>${detExp} (${esc(p.eventos_resumo)})`;
          })
          .join(' &nbsp;·&nbsp; ');
    } else {
      el('paradas-mes-resumo').hidden = true;
    }

    tabela(
      'tabela-editor',
      ['UG', 'Potência (MW)', 'HP', 'HDP', 'HDF', 'HEDP', 'HEDF', 'HRD', 'HDCE', 'HS calculado'],
      ugs.map(ug => {
        const ent = e.edicoes[`${m}|${ug.ug}`] || {};
        const pPlan = mapaPlano.get(ug.ug);
        const usadas = M.CAMPOS.reduce((s, c) => s + (ent[c] || 0), 0);
        const saldo = hp - usadas;
        return [
          `UG ${ug.ug}`,
          numero(ug.potencia_ug_mw, 2),
          hp,
          ...M.CAMPOS.map(c => {
            const isPlanHdp = c === 'HDP' && pPlan && (ent[c] || 0) > 0;
            const isPlanExp =
              pPlan &&
              ((c === 'HRD' && (pPlan.hrd_expurgado || 0) > 0 && (ent[c] || 0) > 0) ||
                (c === 'HDCE' && (pPlan.hdce_expurgado || 0) > 0 && (ent[c] || 0) > 0));
            const cls = isPlanHdp ? 'has-plan' : isPlanExp ? 'has-expurgo' : '';
            const title = isPlanHdp
              ? `HDP líquido do plano: ${numero(pPlan.hdp_programado, 1)} h (${pPlan.eventos_resumo})`
              : isPlanExp
              ? `Expurgo ONS (${c}): ${numero(c === 'HRD' ? pPlan.hrd_expurgado : pPlan.hdce_expurgado, 1)} h [${pPlan.classificadores || ''}]`
              : '';
            return `<input type="number" class="${cls}" title="${esc(title)}" min="0" max="${hp}" step="0.01" value="${esc(ent[c] ?? 0)}" data-ug="${ug.ug}" data-campo="${c}" aria-label="${c} UG ${ug.ug}">`;
          }),
          `<span id="saldo-${ug.ug}" class="${saldo < 0 ? 'saldo-invalido' : ''}">${numero(saldo, 2)}</span>`,
        ];
      })
    );
  }

  function renderSimulacao() {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    try {
      const aplicarExp = e.aplicarExpurgos !== false;
      const planoEdicoes = M.construirEdicoesPlano(D, u.cod_ceg, e.horizonte, { aplicarExpurgos: aplicarExp });
      const planoSemExp = M.construirEdicoesPlano(D, u.cod_ceg, e.horizonte, { aplicarExpurgos: false });
      const sim = M.projetar(D, u.cod_ceg, e.horizonte, e.edicoes, e.idRef);
      const comPlano = M.projetar(D, u.cod_ceg, e.horizonte, planoEdicoes, e.idRef);
      const semExpurgo = M.projetar(D, u.cod_ceg, e.horizonte, planoSemExp, e.idRef);
      const baseline = M.projetar(D, u.cod_ceg, e.horizonte, {}, e.idRef);
      ultimoCenario = sim;
      el('erro-simulacao').hidden = true;
      el('salvar-cenario').disabled = false;

      const fim = sim.resultados.at(-1);
      const fimSemExp = semExpurgo.resultados.at(-1);
      const pior = sim.resultados.reduce((acc, r) => (r.fid_bruto !== null && (!acc || r.fid_bruto < acc.fid_bruto) ? r : acc), null);
      const mesesRisco = sim.resultados.filter(r => r.fid_bruto !== null && r.fid_bruto < 1).length;
      const totalHdpPlano = sim.plano.reduce((s, r) => s + r.HDP, 0);
      const totalExpSim = sim.plano.reduce((s, r) => s + r.HRD + r.HDCE, 0);
      const ganhoIdPp =
        aplicarExp && fim?.id_verificado != null && fimSemExp?.id_verificado != null
          ? (fim.id_verificado - fimSemExp.id_verificado) * 100
          : 0;

      renderKpis('kpis-simulacao', [
        [
          'ID Projetado (fim)',
          pct(fim.id_verificado),
          `Janela ${dataMes(fim.mes)} · Ref: ${pct(e.idRef)}` +
            (ganhoIdPp > 0.0005 ? ` · Expurgo ONS: +${numero(ganhoIdPp, 2)} p.p.` : ''),
          fim.fid_bruto < 1 ? 'red' : 'green',
        ],
        ['FID Bruto / MRA (fim)', numero(fim.fid_bruto, 5), `FID MRA: ${numero(fim.fid_mra, 5)} · Pior: ${pior ? numero(pior.fid_bruto, 4) + ' (' + dataMes(pior.mes) + ')' : '—'}`, fim.fid_bruto < 1 ? 'red' : 'green'],
        ['TEIFa / TEIP (fim)', `${pct(fim.teifa, 2)} / ${pct(fim.teip, 2)}`, `HDP: ${numero(totalHdpPlano, 0)} h · Expurgo (HRD/HDCE): ${numero(totalExpSim, 0)} h`, 'amber'],
        ['Meses com FID < 1', `${mesesRisco} / ${e.horizonte}`, mesesRisco ? 'Atenção: risco de impacto no MRA' : 'Sem risco de penalização no horizonte', mesesRisco ? 'red' : 'green'],
      ]);

      // Headroom / Margem de horas
      const hr = M.calcularMargemHoras(D, u.cod_ceg, fim.mes, e.edicoes, e.idRef);
      const hrBadge = el('headroom-badge');
      if (hr) {
        const posHdp = hr.margem_horas_hdp_ug_media >= 0;
        const posHdf = hr.margem_horas_hdf_ug_media >= 0;
        const deltaIdPp = (hr.id_atual - hr.id_ref) * 100;
        if (hrBadge) {
          hrBadge.textContent = `Fim ${dataMes(hr.mes)} · FID ${numero(hr.fid_atual, 3)}`;
        }
        el('box-headroom').innerHTML = `
          <div class="headroom-grid">
            <div class="headroom-item ${posHdp ? 'is-pos' : 'is-neg'}">
              <div class="headroom-top">
                <span class="headroom-label">Parada Programada</span>
                <span class="headroom-code hdp">HDP</span>
              </div>
              <strong class="${posHdp ? 'num-pos' : 'num-neg'}">${posHdp ? '+' : ''}${numero(hr.margem_horas_hdp_ug_media, 0)} h</strong>
              <div class="headroom-sub">
                <span class="badge ${posHdp ? '' : 'danger'}">${posHdp ? 'Folga' : 'Déficit'}</span>
                <span><strong>${numero(Math.abs(hr.margem_dias_hdp_ug_media), 1)} dias</strong> · 1 UG média</span>
              </div>
            </div>
            <div class="headroom-item ${posHdf ? 'is-pos' : 'is-neg'}">
              <div class="headroom-top">
                <span class="headroom-label">Parada Forçada</span>
                <span class="headroom-code hdf">HDF</span>
              </div>
              <strong class="${posHdf ? 'num-pos' : 'num-neg'}">${posHdf ? '+' : ''}${numero(hr.margem_horas_hdf_ug_media, 0)} h</strong>
              <div class="headroom-sub">
                <span class="badge ${posHdf ? '' : 'danger'}">${posHdf ? 'Folga' : 'Déficit'}</span>
                <span><strong>${numero(Math.abs(hr.margem_dias_hdf_ug_media), 1)} dias</strong> · 1 UG média</span>
              </div>
            </div>
          </div>
          <div class="headroom-foot">
            <div><span>UG média</span><strong>${numero(hr.pot_media_mw, 1)} MW</strong></div>
            <div><span>ID projetado</span><strong>${pct(hr.id_atual, 2)}</strong></div>
            <div><span>ID referência</span><strong>${pct(hr.id_ref, 2)}</strong></div>
            <div><span>Margem ID</span><strong class="${deltaIdPp >= 0 ? 'num-pos' : 'num-neg'}">${deltaIdPp >= 0 ? '+' : ''}${numero(deltaIdPp, 2)} p.p.</strong></div>
          </div>`;
      } else {
        if (hrBadge) hrBadge.textContent = '';
        el('box-headroom').innerHTML = '<div class="empty-state">Janela incompleta para cálculo de margem.</div>';
      }

      // Grafico interativo da simulacao
      const chart = getChart('grafico-simulacao');
      const labels = sim.resultados.map(r => dataMes(r.mes));
      const refPct = Number((e.idRef * 100).toFixed(4));
      let series = [];
      let yAxis = { type: 'value', scale: true };

      if (metricaSim === 'id') {
        yAxis.axisLabel = { formatter: '{value}%' };
        Object.assign(yAxis, limitesEixoYComRef(refPct, 0.5, 2, 100));
        series = [
          {
            name: 'Sem novas indisponibilidades',
            type: 'line',
            smooth: 0.2,
            symbol: 'none',
            lineStyle: { color: CORES.green, type: 'dashed', width: 2 },
            itemStyle: { color: CORES.green },
            data: baseline.resultados.map(r => (r.id_verificado === null ? null : Number((r.id_verificado * 100).toFixed(4)))),
          },
          {
            name: 'Com Paradas Programadas (Plano)',
            type: 'line',
            smooth: 0.2,
            symbolSize: 5,
            lineStyle: { color: CORES.blue, width: 2.5 },
            itemStyle: { color: CORES.blue },
            data: comPlano.resultados.map(r => (r.id_verificado === null ? null : Number((r.id_verificado * 100).toFixed(4)))),
          },
          {
            name: 'Cenário Simulado (Ativo)',
            type: 'line',
            smooth: 0.2,
            symbolSize: 6,
            lineStyle: { color: CORES.amber, width: 3 },
            itemStyle: { color: CORES.amber },
            data: sim.resultados.map(r => (r.id_verificado === null ? null : Number((r.id_verificado * 100).toFixed(4)))),
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: CORES.red, type: 'dashed', width: 2 },
              label: { formatter: `Ref.: ${numero(refPct, 2)}%`, position: 'insideEndTop', color: CORES.red, fontWeight: 600 },
              data: [{ yAxis: refPct }],
            },
          },
        ];
      } else if (metricaSim === 'fid') {
        Object.assign(yAxis, limitesEixoYComRef(1, 0.005, 4));
        series = [
          {
            name: 'FID Bruto · Sem paradas',
            type: 'line',
            symbol: 'none',
            lineStyle: { color: CORES.green, type: 'dashed', width: 2 },
            itemStyle: { color: CORES.green },
            data: baseline.resultados.map(r => (r.fid_bruto === null ? null : Number(r.fid_bruto.toFixed(5)))),
          },
          {
            name: 'FID Bruto · Plano Plurianual',
            type: 'line',
            lineStyle: { color: CORES.blue, width: 2.5 },
            itemStyle: { color: CORES.blue },
            data: comPlano.resultados.map(r => (r.fid_bruto === null ? null : Number(r.fid_bruto.toFixed(5)))),
          },
          {
            name: 'FID Bruto · Cenário Simulado',
            type: 'line',
            lineStyle: { color: CORES.amber, width: 3 },
            itemStyle: { color: CORES.amber },
            data: sim.resultados.map(r => (r.fid_bruto === null ? null : Number(r.fid_bruto.toFixed(5)))),
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: CORES.red, type: 'dashed', width: 2 },
              label: { formatter: 'Limite MRA = 1,000', position: 'insideEndTop', color: CORES.red },
              data: [{ yAxis: 1 }],
            },
          },
          {
            name: 'FID MRA · Simulado',
            type: 'line',
            symbol: 'none',
            lineStyle: { color: CORES.navy, type: 'dotted', width: 2 },
            itemStyle: { color: CORES.navy },
            data: sim.resultados.map(r => (r.fid_mra === null ? null : Number(r.fid_mra.toFixed(5)))),
          },
        ];
      } else {
        yAxis.axisLabel = { formatter: '{value}%' };
        yAxis.scale = false;
        series = [
          { name: 'TEIFa Simulada (%)', type: 'line', smooth: 0.2, itemStyle: { color: CORES.red }, data: sim.resultados.map(r => (r.teifa === null ? null : Number((r.teifa * 100).toFixed(4)))) },
          { name: 'TEIP Simulada (%)', type: 'line', smooth: 0.2, itemStyle: { color: CORES.amber }, data: sim.resultados.map(r => (r.teip === null ? null : Number((r.teip * 100).toFixed(4)))) },
          { name: 'TEIP Plano (%)', type: 'line', smooth: 0.2, symbol: 'none', lineStyle: { type: 'dashed', color: CORES.blue }, itemStyle: { color: CORES.blue }, data: comPlano.resultados.map(r => (r.teip === null ? null : Number((r.teip * 100).toFixed(4)))) },
        ];
      }

      chart.setOption({
        tooltip: {
          trigger: 'axis',
          formatter: params => {
            const itens = Array.isArray(params) ? params : [params];
            const cab = `<strong>${esc(u.usina)} · ${esc(itens[0]?.axisValue || '')}</strong>`;
            const linhasHtml = itens
              .map(p => `${p.marker} ${esc(p.seriesName)}: <strong>${metricaSim === 'fid' ? numero(p.value, 5) : `${numero(p.value, 3)}%`}</strong>`)
              .join('<br/>');
            const notaJupia =
              u.cod_ceg === 'UHE.PH.SP.001282-3.01' && metricaSim !== 'taxas'
                ? '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#475569;line-height:1.35"><strong>Ref. específica (Portaria MME 709/2022):</strong> Jupiá utiliza TEIF/IP individuais (3,190% / 5,923% → 91,076%), diferentes do padrão da Faixa 3 (94,761%).</div>'
                : '';
            return `${cab}<br/>${linhasHtml}${notaJupia}`;
          },
        },
        legend: { top: 4, textStyle: { color: '#3c566b' } },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
        grid: { left: 58, right: 24, top: 48, bottom: 52 },
        xAxis: { type: 'category', data: labels, axisLabel: { color: '#5a7184' } },
        yAxis,
        dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
        series,
      }, true);

      const contagemSim = el('simulacao-contagem');
      if (contagemSim) {
        contagemSim.textContent = `${sim.resultados.length} ${sim.resultados.length === 1 ? 'mês' : 'meses'}`;
      }

      tabela(
        'tabela-simulacao',
        ['Mês Projetado', 'Ref. Contábil', 'Janela 60m', 'Mês Excluído', 'HDP Mês (h)', 'Expurgo ONS (h)', 'TEIFa (%)', 'TEIP (%)', 'ID (%)', 'FID Bruto', 'FID MRA'],
        sim.resultados.map(r => {
          const itensMes = sim.plano.filter(p => p.mes === r.mes);
          const hdpMes = itensMes.reduce((s, p) => s + p.HDP, 0);
          const expMes = itensMes.reduce((s, p) => s + p.HRD + p.HDCE, 0);
          return [
            `<strong>${dataMes(r.mes)}</strong>`,
            dataMes(r.mes_referencia_contabil),
            `${dataMes(r.mes_inicio_historico)}–${dataMes(r.mes)}`,
            dataMes(r.mes_excluido),
            numero(hdpMes, 1),
            expMes > 0 ? `<span class="num-pos">${numero(expMes, 1)}</span>` : '0,0',
            numero(r.teifa === null ? null : r.teifa * 100),
            numero(r.teip === null ? null : r.teip * 100),
            `<strong>${numero(r.id_verificado === null ? null : r.id_verificado * 100)}</strong>`,
            badgeFid(r.fid_bruto),
            numero(r.fid_mra, 4),
          ];
        })
      );
    } catch (erro) {
      ultimoCenario = null;
      el('erro-simulacao').textContent = erro.message;
      el('erro-simulacao').hidden = false;
      el('salvar-cenario').disabled = true;
      clearChart('grafico-simulacao', 'Corrija os valores de horas acima de HP para recalcular.');
      el('tabela-simulacao').innerHTML = '';
      if (el('simulacao-contagem')) el('simulacao-contagem').textContent = '';
    }
  }

  // ==================== 3. PARADAS PROGRAMADAS ====================
  function renderManutencoes() {
    renderContextoFiltro('manut');
    const polo = el('polo').value;
    const ceg = el('usina').value;
    const ano = el('manut-ano').value;
    const tipo = el('manut-tipo').value;
    const classif = el('manut-classificador') ? el('manut-classificador').value : '';
    const st = el('manut-status').value;
    const busca = (el('manut-busca').value || '').trim().toLowerCase();

    let lista = (D.manutencoes || []).filter(m => {
      if (polo && m.polo !== polo) return false;
      if (ceg && m.cod_ceg !== ceg) return false;
      if (ano && String(m.ano_inicio) !== ano) return false;
      if (tipo && m.tipo_manut !== tipo) return false;
      if (classif) {
        const cAtual = m.classificador || 'SEM_CLASS';
        if (cAtual !== classif) return false;
      }
      const noPlano = m.ativa_no_plano ?? m.ativa_para_calculo;
      if (st === 'plano' && !noPlano) return false;
      if (st === 'ativas' && !m.ativa_para_calculo) return false;
      if (st === 'expurgadas' && !(noPlano && (m.expurgo_horas || 0) > 0)) return false;
      if (st === 'canceladas' && m.status !== 'Cancelado') return false;
      if (busca) {
        const alvo = `${m.usina} ${m.ug_str} ${m.tipo_manut} ${m.classificador || ''} ${m.destino_ons || ''} ${m.descricao_breve} ${m.descricao_completa} ${m.estagio}`.toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });

    const ativasPlano = lista.filter(m => m.ativa_no_plano ?? m.ativa_para_calculo);
    const ativasHdp = lista.filter(m => m.ativa_para_calculo);
    const totalExpurgadas100 = ativasPlano.filter(m => (m.indisponibilidade_horas || 0) <= 0 && (m.expurgo_horas || 0) > 0).length;
    const totalBrutas = ativasPlano.reduce((s, m) => s + (m.horas_brutas ?? ((m.indisponibilidade_horas || 0) + (m.expurgo_horas || 0))), 0);
    const totalHoras = ativasPlano.reduce((s, m) => s + (m.indisponibilidade_horas || 0), 0);
    const totalExpurgo = ativasPlano.reduce((s, m) => s + (m.expurgo_horas || 0), 0);
    const expAutoOns = ativasPlano
      .filter(m => m.expurgo_origem === 'CLASSIFICADOR_ONS')
      .reduce((s, m) => s + (m.expurgo_horas || 0), 0);
    const pctExpurgo = totalBrutas > 0 ? (100 * totalExpurgo) / totalBrutas : 0;
    const mods = ativasPlano.filter(m => m.tipo_manut === 'MOD').length;
    const mpps = ativasPlano.filter(m => String(m.tipo_manut || '').startsWith('MPP')).length;

    renderKpis('kpis-manut', [
      ['Intervenções Listadas', String(lista.length), `${ativasHdp.length} geram HDP · ${totalExpurgadas100} 100% expurgadas`, ''],
      ['Indisponibilidade Líquida (HDP)', `${numero(totalHoras, 0)} h`, `${numero(totalHoras / 24, 1)} dias-UG · de ${numero(totalBrutas, 0)} h brutas`, 'amber'],
      [
        'Horas Expurgadas (ONS)',
        `${numero(totalExpurgo, 0)} h`,
        `${numero(pctExpurgo, 1)}% de redução` + (expAutoOns > 0 ? ` (${numero(expAutoOns, 0)} h auto via Classif.)` : ' (HRD / HDCE)'),
        'green',
      ],
      ['Grandes Paradas (MPP / MOD)', `${mpps} MPP · ${mods} MOD`, 'Manutenções periódicas e modernizações', ''],
    ]);

    // 1) Grafico mensal empilhado por tipo + horas expurgadas ONS (rateio cronologico exato)
    const mensalFiltrado = (D.manutencoes_mensal || []).filter(m => {
      const u = D.usinas.find(x => x.cod_ceg === m.cod_ceg);
      if (polo && u?.polo !== polo) return false;
      if (ceg && m.cod_ceg !== ceg) return false;
      if (ano && !String(m.mes).startsWith(ano)) return false;
      if (tipo && !String(m.tipos_manut || '').includes(tipo)) return false;
      if (classif && !String(m.classificadores || '').split(',').map(x => x.trim()).includes(classif)) return false;
      return true;
    });

    const mesesOrd = [...new Set(mensalFiltrado.map(m => mes(m.mes)))].sort();
    if (!mesesOrd.length) {
      clearChart('grafico-manut-mensal', 'Sem paradas ativas no filtro selecionado.');
    } else {
      const porMes = new Map(mesesOrd.map(mm => [mm, { mod: 0, mpp: 0, outros: 0, expurgo: 0 }]));
      for (const r of mensalFiltrado) {
        const slot = porMes.get(mes(r.mes));
        if (r.tem_mod) slot.mod += r.hdp_programado;
        else if (r.tem_mpp) slot.mpp += r.hdp_programado;
        else slot.outros += r.hdp_programado;
        slot.expurgo += r.horas_expurgadas || 0;
      }
      const chartM = getChart('grafico-manut-mensal');
      chartM.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
        legend: { top: 4, left: 'center' },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 10 },
        grid: { left: 62, right: 20, top: 48, bottom: 48 },
        xAxis: { type: 'category', data: mesesOrd.map(dataMes), axisLabel: { color: '#5a7184' } },
        yAxis: { type: 'value', axisLabel: { color: '#5a7184', formatter: '{value} h' } },
        dataZoom: mesesOrd.length > 14 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 6 }] : [],
        series: [
          { name: 'MOD · HDP Líq.', type: 'bar', stack: 'h', itemStyle: { color: CORES.red }, data: mesesOrd.map(mm => Number(porMes.get(mm).mod.toFixed(1))) },
          { name: 'MPP · HDP Líq.', type: 'bar', stack: 'h', itemStyle: { color: CORES.blue }, data: mesesOrd.map(mm => Number(porMes.get(mm).mpp.toFixed(1))) },
          { name: 'Outras · HDP Líq.', type: 'bar', stack: 'h', itemStyle: { color: CORES.amber }, data: mesesOrd.map(mm => Number(porMes.get(mm).outros.toFixed(1))) },
          { name: 'Expurgadas ONS (HRD/HDCE)', type: 'bar', stack: 'h', itemStyle: { color: CORES.green, opacity: 0.78, borderRadius: [4, 4, 0, 0] }, data: mesesOrd.map(mm => Number(porMes.get(mm).expurgo.toFixed(1))) },
        ],
      }, true);
    }

    // 2) Grafico por usina (HDP liquido vs Expurgo ONS)
    const somaUsina = new Map();
    for (const r of mensalFiltrado) {
      const slot = somaUsina.get(r.usina) || { hdp: 0, exp: 0 };
      slot.hdp += r.hdp_programado || 0;
      slot.exp += r.horas_expurgadas || 0;
      somaUsina.set(r.usina, slot);
    }
    const rankU = [...somaUsina.entries()].sort((a, b) => (a[1].hdp + a[1].exp) - (b[1].hdp + b[1].exp));
    if (!rankU.length) {
      clearChart('grafico-manut-usina', 'Sem horas programadas para exibir por usina.');
    } else {
      const chartU = getChart('grafico-manut-usina');
      chartU.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: v => `${numero(v, 1)} h` },
        legend: { top: 4 },
        toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 10 },
        grid: { left: 112, right: 28, top: 38, bottom: 32 },
        xAxis: { type: 'value', axisLabel: { color: '#5a7184' } },
        yAxis: { type: 'category', data: rankU.map(x => x[0]), axisLabel: { color: '#162e42', fontWeight: 600 } },
        series: [
          {
            name: 'HDP Líquido (h)',
            type: 'bar',
            stack: 'u',
            barMaxWidth: 22,
            data: rankU.map(x => Number(x[1].hdp.toFixed(1))),
            itemStyle: { color: CORES.teal },
          },
          {
            name: 'Expurgado ONS (h)',
            type: 'bar',
            stack: 'u',
            barMaxWidth: 22,
            data: rankU.map(x => Number(x[1].exp.toFixed(1))),
            itemStyle: { color: CORES.green, opacity: 0.78, borderRadius: [0, 5, 5, 0] },
          },
        ],
      }, true);
    }

    // 3) Cronograma Gantt interativo
    renderGanttManut(ativasPlano, ano);

    // 4) Tabela de catalogo
    el('contagem-manut').textContent = `Exibindo ${Math.min(lista.length, 300)} de ${lista.length} registros.`;
    tabela(
      'tabela-manut',
      ['Usina', 'UG', 'Tipo', 'Classif.', 'Estágio', 'Início', 'Término', 'Dias', 'Ret. Diário', 'Bruto (h)', 'Expurgo (h)', 'HDP Líq. (h)', 'Destino ONS', 'Descrição'],
      lista.slice(0, 300).map(m => {
        const bruto = m.horas_brutas ?? ((m.indisponibilidade_horas || 0) + (m.expurgo_horas || 0));
        const expTag =
          m.expurgo_origem === 'CLASSIFICADOR_ONS'
            ? `<span class="num-pos" title="${esc(rotuloOrigemExpurgo(m.expurgo_origem))}">${numero(m.expurgo_horas, 1)}*</span>`
            : (m.expurgo_horas || 0) > 0
            ? `<span class="num-pos" title="${esc(rotuloOrigemExpurgo(m.expurgo_origem))}">${numero(m.expurgo_horas, 1)}</span>`
            : '0,0';
        const destCls =
          m.destino_ons === 'HRD' ? '' : m.destino_ons === 'HDCE' ? 'info' : m.destino_ons === 'HDP' ? 'warn' : 'neutral';
        return [
          `<strong>${esc(m.usina)}</strong>`,
          esc(m.ug_str),
          `<span class="badge info" style="background:${TIPO_COR[m.tipo_manut] || '#475569'}20;color:${TIPO_COR[m.tipo_manut] || '#334155'}">${esc(m.tipo_manut)}</span>`,
          badgeClassificador(m.classificador, m.grupo_ons),
          `<span class="badge ${m.status === 'Cancelado' ? 'danger' : m.estagio === 'Executado' ? '' : 'neutral'}">${esc(m.estagio)}</span>`,
          dataDia(m.data_inicio),
          dataDia(m.data_fim),
          m.duracao_dias ?? '—',
          m.retorno_diario ? 'Sim (12h)' : 'Não (24h)',
          numero(bruto, 1),
          expTag,
          `<strong>${numero(m.indisponibilidade_horas, 1)}</strong>`,
          `<span class="badge ${destCls}">${esc(m.destino_ons || '—')}</span>`,
          { html: esc(m.descricao_completa || m.descricao_breve), cls: 'text-left' },
        ];
      })
    );

    // 5) Auditoria de Franquias Regulatorias ONS (GIM 12m/UG e GMT 360h/UG)
    const frFilt = (D.auditoria_franquias || []).filter(f => {
      const u = D.usinas.find(x => x.cod_ceg === f.cod_ceg);
      if (polo && u?.polo !== polo) return false;
      if (ceg && f.cod_ceg !== ceg) return false;
      if (classif && classif !== f.classificador) return false;
      return true;
    });
    const frExced = frFilt.filter(f => f.status === 'EXCEDIDO').length;
    const frLim = frFilt.filter(f => f.status === 'NO_LIMITE').length;
    if (el('resumo-franquias')) {
      el('resumo-franquias').textContent =
        `${frFilt.length} registros auditados (GIM limite 8.760 h/UG · GMT limite 360 h × UGs)` +
        (frExced ? ` · ${frExced} com expurgo declarado acima do teto regulatório` : '') +
        (frLim ? ` · ${frLim} próximos do limite (≥ 85%)` : '');
    }
    if (el('tabela-franquias')) {
      tabela(
        'tabela-franquias',
        ['Classif.', 'Usina', 'UG / Escopo', 'Período', 'Eventos', 'Bruto (h)', 'Expurgo Decl. (h)', 'Exced. HDP (h)', 'Limite ONS (h)', 'Saldo (h)', 'Uso (%)', 'Status'],
        frFilt.map(f => [
          badgeClassificador(f.classificador, '7.1.3.2'),
          `<strong>${esc(f.usina)}</strong>`,
          f.numero_ug != null ? `UG ${String(f.numero_ug).padStart(2, '0')}` : esc(f.escopo),
          esc(f.periodo_anos),
          f.qtd_eventos,
          numero(f.horas_brutas, 1),
          numero(f.horas_expurgo_declarado, 1),
          numero(f.horas_hdp_excedente, 1),
          numero(f.limite_franquia_horas, 0),
          `<span class="${f.saldo_franquia_horas < 0 ? 'num-neg' : 'num-pos'}">${f.saldo_franquia_horas >= 0 ? '+' : ''}${numero(f.saldo_franquia_horas, 1)}</span>`,
          `${numero(f.uso_franquia_pct, 1)}%`,
          `<span class="badge ${f.status === 'EXCEDIDO' ? 'danger' : f.status === 'NO_LIMITE' ? 'warn' : ''}">${f.status === 'EXCEDIDO' ? 'Acima do Teto' : f.status === 'NO_LIMITE' ? 'No Limite' : 'OK'}</span>`,
        ])
      );
    }
  }

  function renderGanttManut(ativas, ano) {
    const elegiveis = ativas.filter(m => m.data_inicio && m.data_fim).slice(0, 140);
    if (!elegiveis.length) {
      clearChart('grafico-manut-gantt', 'Nenhuma parada ativa com datas válidas para o Gantt.');
      return;
    }
    const categorias = [...new Set(elegiveis.map(m => `${m.sigla_uhe} · ${m.ug_str}`))].sort().slice(0, 26);
    const catSet = new Set(categorias);
    const itens = elegiveis.filter(m => catSet.has(`${m.sigla_uhe} · ${m.ug_str}`));

    const chart = getChart('grafico-manut-gantt');
    const dataGantt = itens.map(m => {
      const yIdx = categorias.indexOf(`${m.sigla_uhe} · ${m.ug_str}`);
      const tIni = new Date(m.data_inicio + 'T00:00:00Z').getTime();
      const tFim = new Date(m.data_fim + 'T00:00:00Z').getTime() + 86400000;
      return {
        name: m.descricao_breve,
        value: [yIdx, tIni, tFim, m.indisponibilidade_horas, m.tipo_manut, m.usina, m.ug_str, m.descricao_completa, m.duracao_dias],
        itemStyle: { color: TIPO_COR[m.tipo_manut] || CORES.blue },
      };
    });

    chart.setOption({
      tooltip: {
        formatter: p => {
          const v = p.value;
          return `<strong>${esc(v[5])} · ${esc(v[6])}</strong> (${esc(v[4])})<br/>
            ${esc(v[7] || p.name)}<br/>
            Período: ${dataDia(new Date(v[1]).toISOString())} a ${dataDia(new Date(v[2] - 86400000).toISOString())} (${v[8]} dias)<br/>
            Indisponibilidade líquida: <strong>${numero(v[3], 1)} h</strong>`;
        },
      },
      toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 12 },
      grid: { left: 105, right: 24, top: 24, bottom: 52 },
      xAxis: { type: 'time', axisLabel: { color: '#5a7184' } },
      yAxis: { type: 'category', data: categorias, inverse: true, axisLabel: { color: '#162e42', fontSize: 11 } },
      dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', xAxisIndex: 0, height: 18, bottom: 8 }],
      series: [
        {
          type: 'custom',
          renderItem: (params, api) => {
            const catIdx = api.value(0);
            const start = api.coord([api.value(1), catIdx]);
            const end = api.coord([api.value(2), catIdx]);
            const h = Math.max(8, Math.min(18, api.size([0, 1])[1] * 0.62));
            const w = Math.max(4, end[0] - start[0]);
            const rect = echarts.graphic.clipRectByRect(
              { x: start[0], y: start[1] - h / 2, width: w, height: h },
              { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height }
            );
            return rect && { type: 'rect', shape: { ...rect, r: 3 }, style: api.style() };
          },
          encode: { x: [1, 2], y: 0 },
          data: dataGantt,
        },
      ],
    }, true);
  }

  // ==================== 4. PROJEÇÃO ID REF ====================
  function mesCorteProjecao() {
    const sel = el('proj-mes-corte')?.value;
    if (sel) return sel;
    if (D.sin_meses && D.sin_meses.length) return D.sin_meses[0];
    return D.projecao_faixas?.[0]?.mes_ons ? mes(D.projecao_faixas[0].mes_ons) : D.mes_base;
  }

  function sinUsinasAtuais() {
    return M.resolverSinUsinasNoMes(D, mesCorteProjecao());
  }

  function renderProjecao() {
    const mesCorte = mesCorteProjecao();
    const fatorTeif = Number(el('fator-teif').value);
    const fatorTeip = Number(el('fator-teip').value);
    const excluirPimental = el('chk-excluir-pimental').checked;
    const excluirBeloMonte = el('chk-excluir-belomonte').checked;
    const incluirItaipu = el('chk-incluir-itaipu').checked;

    el('val-fator-teif').textContent = `${numero(fatorTeif, 2)}×`;
    el('val-fator-teip').textContent = `${numero(fatorTeip, 2)}×`;

    const refMap = {};
    for (const f of (D.projecao_faixas || [])) refMap[f.faixa] = f;
    const sinUsinas = M.resolverSinUsinasNoMes(D, mesCorte);
    const faixas = M.calcularProjecao2028(sinUsinas, refMap, {
      fatorTeif,
      fatorTeip,
      excluirPimental,
      excluirBeloMonte,
      incluirItaipu,
      overrides: sinOverrides,
    });
    const faixaById = Object.fromEntries(faixas.map(f => [f.faixa, f]));

    const mesOns = dataMes(mesCorte);

    // Calcula situacao das 12 UHEs CTG (atual na data de corte + projetado +24m com paradas programadas)
    const ctgRows = D.usinas.map(u => {
      const atual = D.acumulado.find(r => r.cod_ceg === u.cod_ceg && mes(r.mes_fim_historico) === mesCorte);
      const plano24 = M.construirEdicoesPlano(D, u.cod_ceg, 24, { mesBase: mesCorte });
      let proj24 = null;
      try { proj24 = M.projetar(D, u.cod_ceg, 24, plano24, u.id_referencia, mesCorte).resultados.at(-1); } catch (_) {}
      const fx = faixaById[u.faixa];
      const idAtual = atual?.id_verificado != null ? atual.id_verificado * 100 : null;
      const idProj = proj24?.id_verificado != null ? proj24.id_verificado * 100 : null;
      const idFaixa = fx?.id_proj_2028_pct ?? null;
      const deltaAtual = idAtual !== null && idFaixa !== null ? idAtual - idFaixa : null;
      const deltaProj = idProj !== null && idFaixa !== null ? idProj - idFaixa : null;
      return {
        ...u,
        qtde_ugs: D.ugs.filter(g => g.cod_ceg === u.cod_ceg).length,
        teifa_pct: atual?.teifa != null ? atual.teifa * 100 : null,
        teip_pct: atual?.teip != null ? atual.teip * 100 : null,
        id_atual_pct: idAtual,
        id_proj24_pct: idProj,
        id_mme22_pct: u.id_referencia * 100,
        id_faixa28_pct: idFaixa,
        delta_atual_pp: deltaAtual,
        delta_proj_pp: deltaProj,
      };
    });

    const totalUgsSin = faixas.reduce((s, f) => s + f.ugs_sin, 0);
    const totalUsinasSin = faixas.reduce((s, f) => s + f.usinas_sin, 0);
    const ctgAbaixo28 = ctgRows.filter(r => r.delta_proj_pp !== null && r.delta_proj_pp < 0);
    const f3 = faixaById[3];

    renderKpis('kpis-proj', [
      ['Universo SIN Elegível', `${totalUsinasSin} UHEs`, `${totalUgsSin} UGs ponderadas · corte ${mesOns}`, ''],
      ['Faixa 3 (7 UHEs CTG)', pct100(f3?.id_proj_2028_pct, 2), `Ref. 2022: ${pct100(f3?.id_ref_2022_pct, 2)} (Δ ${f3?.delta_2028_2022_pp >= 0 ? '+' : ''}${numero(f3?.delta_2028_2022_pp, 2)} p.p.)`, 'amber'],
      ['CTG Abaixo da Faixa 2028', String(ctgAbaixo28.length), ctgAbaixo28.length ? ctgAbaixo28.map(r => r.usina).join(', ') : 'Todas acima da nova referência projetada', ctgAbaixo28.length ? 'red' : 'green'],
      ['Horizonte com Paradas', '+24 meses', `Projeção até ${dataMes(M.moverMes(mesCorte, 24))} c/ plano plurianual`, 'green'],
    ]);

    // Grafico 1: 5 faixas 2022 vs 2028
    const chF = getChart('grafico-proj-faixas');
    chF.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 4 },
      toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 10 },
      grid: { left: 54, right: 20, top: 42, bottom: 38 },
      xAxis: { type: 'category', data: faixas.map(f => `F${f.faixa} (${f.faixa_label})`), axisLabel: { color: '#3c566b', fontSize: 11 } },
      yAxis: { type: 'value', min: 92, max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        { name: 'Referência 2022 (%)', type: 'bar', barMaxWidth: 26, itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] }, data: faixas.map(f => Number(f.id_ref_2022_pct.toFixed(3))) },
        { name: 'Projeção 2028 (%)', type: 'bar', barMaxWidth: 26, itemStyle: { color: CORES.blue, borderRadius: [4, 4, 0, 0] }, data: faixas.map(f => (f.id_proj_2028_pct === null ? null : Number(f.id_proj_2028_pct.toFixed(3)))) },
      ],
    }, true);

    // Grafico 2: 12 UHEs CTG vs Faixa 2028
    const ordCtg = [...ctgRows].sort((a, b) => (a.delta_proj_pp ?? 0) - (b.delta_proj_pp ?? 0));
    const chC = getChart('grafico-proj-ctg');
    chC.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 4 },
      toolbox: { feature: { saveAsImage: { title: 'Salvar PNG' } }, right: 10 },
      grid: { left: 54, right: 18, top: 42, bottom: 56 },
      xAxis: { type: 'category', data: ordCtg.map(r => r.usina), axisLabel: { rotate: 24, color: '#3c566b', fontSize: 11 } },
      yAxis: { type: 'value', min: v => Math.max(85, Math.floor(v.min - 2)), max: 100, axisLabel: { formatter: '{value}%' } },
      series: [
        { name: 'ID Atual (60m)', type: 'bar', barMaxWidth: 18, itemStyle: { color: CORES.blue, borderRadius: [4, 4, 0, 0] }, data: ordCtg.map(r => (r.id_atual_pct === null ? null : Number(r.id_atual_pct.toFixed(2)))) },
        { name: 'ID Projetado (+24m c/ Paradas)', type: 'bar', barMaxWidth: 18, itemStyle: { color: CORES.teal, borderRadius: [4, 4, 0, 0] }, data: ordCtg.map(r => (r.id_proj24_pct === null ? null : Number(r.id_proj24_pct.toFixed(2)))) },
        { name: 'Faixa 2028 (%)', type: 'scatter', symbol: 'rect', symbolSize: [24, 4], z: 6, itemStyle: { color: CORES.amber }, data: ordCtg.map(r => (r.id_faixa28_pct === null ? null : Number(r.id_faixa28_pct.toFixed(2)))) },
      ],
    }, true);

    // Tabela Faixas
    tabela(
      'tabela-proj-faixas',
      ['Faixa', 'Potência Unitária', 'UGs SIN', 'Usinas SIN', 'TEIFa 2028 (%)', 'TEIP 2028 (%)', 'Dispon. 2028 (%)', 'Ref. 2022 (%)', 'Δ 2028−2022 (p.p.)'],
      faixas.map(f => [
        `<strong>Faixa ${f.faixa}</strong>`,
        esc(f.faixa_label),
        f.ugs_sin,
        f.usinas_sin,
        numero(f.teifa_proj_pct),
        numero(f.teip_proj_pct),
        `<strong>${numero(f.id_proj_2028_pct)}</strong>`,
        numero(f.id_ref_2022_pct),
        `<span class="${f.delta_2028_2022_pp >= 0 ? 'num-neg' : 'num-pos'}">${f.delta_2028_2022_pp >= 0 ? '+' : ''}${numero(f.delta_2028_2022_pp)}</span>`,
      ])
    );

    // Tabela CTG agrupada por Polo
    const polosOrdem = ['Polo Chavantes', 'Polo Capivara', 'Polo Jupiá', 'Polo Ilha Solteira'];
    const linhasCtg = [];
    for (const p of polosOrdem) {
      const grp = ctgRows.filter(r => r.polo === p);
      if (!grp.length) continue;
      linhasCtg.push({ __group: p });
      for (const r of grp) {
        const clsD = r.delta_proj_pp !== null && r.delta_proj_pp < 0 ? 'num-neg' : 'num-pos';
        linhasCtg.push([
          `<strong>${esc(r.usina)}</strong>`,
          r.qtde_ugs,
          `Faixa ${r.faixa}`,
          numero(r.teifa_pct),
          numero(r.teip_pct),
          numero(r.id_mme22_pct),
          numero(r.id_faixa28_pct),
          `<strong>${numero(r.id_atual_pct)}</strong>`,
          `<strong>${numero(r.id_proj24_pct)}</strong>`,
          `<span class="${clsD}">${r.delta_proj_pp >= 0 ? '+' : ''}${numero(r.delta_proj_pp)} p.p.</span>`,
        ]);
      }
    }
    tabela(
      'tabela-proj-ctg',
      ['Usina', 'UGs', 'Faixa', 'TEIFa (%)', 'TEIP (%)', 'Ref. MME 2022 (%)', 'Faixa 2028 (%)', 'ID Atual (%)', 'ID Proj. +24m (%)', 'Folga vs. 2028'],
      linhasCtg
    );

    // Validacao 2022
    tabela(
      'tabela-validacao-2022',
      ['Faixa', 'Teto (MW/UG)', 'UGs Publ.', 'UGs Base', 'TEIF Publ. (%)', 'TEIF Calc. (%)', 'IP Publ. (%)', 'IP Calc. (%)', 'ID Publ. (%)', 'ID Calc. (%)', 'Resultado'],
      (D.validacao_2022 || []).map(v => [
        `Faixa ${v.faixa}`,
        `${v.teto_mw} MW`,
        v.ugs_publ,
        v.ugs_base,
        numero(v.teif_publ_pct),
        numero(v.teif_calc_pct),
        numero(v.ip_publ_pct),
        numero(v.ip_calc_pct),
        numero(v.id_publ_pct),
        numero(v.id_calc_pct),
        `<span class="badge ${v.resultado === 'REPRODUZ' ? '' : 'warn'}">${esc(v.resultado)}</span>`,
      ])
    );

    renderTabelaSinConfig(sinUsinas);
  }

  function sinUsinaAtiva(u) {
    const elegivelTecnico =
      u.faixa >= 1 && u.faixa <= 5 && u.ugs > 0 && Number.isFinite(u.teifa_pct) && Number.isFinite(u.teip_pct);
    if (Object.prototype.hasOwnProperty.call(sinOverrides, u.id_sin)) {
      return { ativa: elegivelTecnico && Boolean(sinOverrides[u.id_sin]), alterada: true, elegivelTecnico };
    }
    let ativa = Boolean(u.valida_calculo);
    if (u.id_sin === 'SIN83-GERAL') ativa = el('chk-incluir-itaipu').checked && elegivelTecnico;
    if (el('chk-excluir-pimental').checked && u.id_sin === 'TAX165') ativa = false;
    if (el('chk-excluir-belomonte').checked && u.id_sin === 'SIN76') ativa = false;
    return { ativa, alterada: ativa !== Boolean(u.valida_calculo), elegivelTecnico };
  }

  function renderTabelaSinConfig(sinUsinasLista = null) {
    const filtroFaixa = el('sin-filtro-faixa').value;
    const filtroStatus = el('sin-filtro-status').value;
    const busca = (el('sin-busca').value || '').trim().toLowerCase();
    const fatorTeif = Number(el('fator-teif').value);
    const fatorTeip = Number(el('fator-teip').value);

    const todas = (sinUsinasLista || sinUsinasAtuais()).map(u => ({ ...u, ...sinUsinaAtiva(u) }));
    const totalAtivas = todas.filter(u => u.ativa).length;
    const totalUgsAtivas = todas.filter(u => u.ativa).reduce((s, u) => s + (u.ugs || 0), 0);
    const totalAlteradas = todas.filter(u => u.alterada).length;

    const filtradas = todas.filter(u => {
      if (filtroFaixa !== '' && String(u.faixa) !== filtroFaixa) return false;
      if (filtroStatus === 'ativas' && !u.ativa) return false;
      if (filtroStatus === 'fora' && u.ativa) return false;
      if (filtroStatus === 'alteradas' && !u.alterada) return false;
      if (filtroStatus === 'ctg' && !u.usina_ctg) return false;
      if (busca) {
        const alvo = `${u.id_sin} ${u.usina_cadastro} ${u.usina_ons} ${u.cod_ceg}`.toLowerCase();
        if (!alvo.includes(busca)) return false;
      }
      return true;
    });

    el('sin-cfg-resumo').textContent =
      `Ativas no cálculo: ${totalAtivas} usinas (${totalUgsAtivas} UGs)` +
      (totalAlteradas ? ` · ${totalAlteradas} alteração(ões) de simulação ativa(s)` : ' · Configuração padrão SIN') +
      ` · Exibindo ${filtradas.length} de ${todas.length} registros.`;

    tabela(
      'tabela-sin-config',
      ['Cálculo', 'ID', 'Usina (Cadastro SIN)', 'CEG', 'Faixa', 'UGs', 'Motorização', 'TEIFa (%)', 'TEIP (%)', 'ID Atual (%)', 'Situação'],
      filtradas.map(u => {
        let sitBadge;
        if (!u.elegivelTecnico) {
          const motivo = u.faixa < 1 || u.faixa > 5 ? 'Sem faixa (1–5)' : u.ugs <= 0 ? 'Sem UGs' : 'Sem taxa ONS';
          sitBadge = `<span class="badge neutral">${motivo}</span>`;
        } else if (u.alterada && u.ativa) {
          sitBadge = '<span class="badge info">Inserida (sim.)</span>';
        } else if (u.alterada && !u.ativa) {
          sitBadge = '<span class="badge warn">Retirada (sim.)</span>';
        } else if (u.ativa) {
          sitBadge = '<span class="badge">Ativa</span>';
        } else {
          const rotulo = u.excluida
            ? 'Excluída padrão'
            : !u.no_painel_base
              ? 'Opcional (sim.)'
              : !u.incluida
                ? 'Fora do cadastro'
                : 'Motorização < 60m';
          sitBadge = `<span class="badge neutral">${rotulo}</span>`;
        }
        const teifaAj = Number.isFinite(u.teifa_pct) ? Math.min(100, u.teifa_pct * fatorTeif) : null;
        const teipAj = Number.isFinite(u.teip_pct) ? Math.min(100, u.teip_pct * fatorTeip) : null;
        const idAj = teifaAj !== null && teipAj !== null ? 100 * (1 - teifaAj / 100) * (1 - teipAj / 100) : null;
        const ctgTag = u.usina_ctg ? ' <span class="badge info" style="margin-left:5px">CTG</span>' : '';
        const titleChk = u.elegivelTecnico
          ? 'Marque para incluir ou desmarque para retirar esta usina da simulação'
          : 'Indisponível para cálculo (faixa fora de 1–5, UGs = 0 ou sem taxa ONS)';
        return [
          `<input type="checkbox" class="sin-chk" data-sin-id="${esc(u.id_sin)}" ${u.ativa ? 'checked' : ''} ${u.elegivelTecnico ? '' : 'disabled'} title="${esc(titleChk)}" aria-label="Incluir ${esc(u.usina_cadastro)} no cálculo">`,
          esc(u.id_sin),
          `<strong>${esc(u.usina_cadastro)}</strong>${ctgTag}`,
          `<span style="font-family:Consolas,monospace;font-size:0.78rem">${esc(u.cod_ceg)}</span>`,
          u.faixa >= 1 && u.faixa <= 5 ? `Faixa ${u.faixa}` : '—',
          u.ugs,
          dataDia(u.motorizacao),
          numero(teifaAj),
          numero(teipAj),
          `<strong>${numero(idAj)}</strong>`,
          sitBadge,
        ];
      }),
      idx => (filtradas[idx].alterada ? 'class="row-override"' : '')
    );
  }

  // ==================== 5. METODOLOGIA & ONS ====================
  function renderMetodologia() {
    if (el('tabela-classificadores')) {
      tabela(
        'tabela-classificadores',
        ['Sigla', 'Grupo ONS', 'Impacta Taxas?', 'Destino ONS', 'Aplica UHE', 'Franquia / Regra de Excedente', 'Significado Oficial (RO-AO.BR.04 Rev. 47)'],
        (D.classificadores_ons || []).map(c => [
          badgeClassificador(c.codigo, c.grupo_ons),
          esc(c.grupo_ons),
          c.impacta_taxas
            ? '<span class="badge danger">Sim (Penaliza)</span>'
            : '<span class="badge">Não (Expurgo)</span>',
          `<strong>${esc(c.destino_parametro)}</strong>`,
          c.aplica_uhe ? 'UHE' : '<span class="badge neutral">UTE</span>',
          { html: esc(c.regra_excedente), cls: 'text-left' },
          { html: `<strong>${esc(c.nome)}:</strong> ${esc(c.descricao)}`, cls: 'text-left' },
        ])
      );
    }

    const ult = D.mes_base;
    const conc = D.conciliacao.filter(c => mes(c.mes_fim_historico) === ult);
    const ok = conc.filter(c => c.status === 'OK').length;
    el('badge-conciliacao').textContent = `${ok}/${conc.length} taxas OK em ${dataMes(ult)}`;

    tabela(
      'tabela-conciliacao',
      ['Usina', 'Taxa', 'Calculada (%)', 'Publicada ONS (%)', 'Diferença (p.p.)', 'Meses Válidos', 'Status'],
      conc.map(c => [
        `<strong>${esc(c.usina)}</strong>`,
        esc(c.taxa),
        numero(c.calculada === null ? null : c.calculada * 100, 6),
        numero(c.publicada === null ? null : c.publicada * 100, 6),
        numero(c.diferenca_pp, 6),
        `${c.meses_validos}/60`,
        `<span class="badge ${c.status === 'OK' ? '' : 'warn'}">${esc(c.status)}</span>`,
      ])
    );

    tabela(
      'tabela-auditoria',
      ['Usina', 'UG', 'Mês', 'HP', 'Soma Horas', 'Saldo (h)', 'Ressalva', 'Válido', 'Motivo'],
      (D.auditoria_fechamento || []).map(a => [
        esc(a.usina),
        `UG ${a.numero_ug}`,
        dataMes(a.mes),
        numero(a.hp, 2),
        numero(a.soma_horas, 2),
        numero(a.saldo_horas, 2),
        a.ressalva_fechamento ? '<span class="badge warn">Sim</span>' : 'Não',
        a.valido ? '<span class="badge">Sim</span>' : '<span class="badge danger">Não</span>',
        { html: esc(a.motivo_ressalva || 'Saldo fora da tolerância de 0,01 h'), cls: 'text-left' },
      ])
    );
  }

  // ==================== 6. ADMINISTRADOR ====================
  async function apiJson(url, opts = {}) {
    const reqOpts = { ...opts };
    if (getApiBase()) reqOpts.credentials = 'include';
    const res = await fetch(apiUrl(url), reqOpts);
    const body = await res.json().catch(() => ({}));
    if (body.sessao_expirada && el('sessao-painel')) location.replace('/login');
    if (!res.ok) throw new Error(body.erro || `Erro HTTP ${res.status}`);
    return body;
  }

  async function inicializarAdmin() {
    const mobCfg = el('mobile-api-config');
    if (mobCfg) {
      mobCfg.hidden = !(isNativeApp() || isMobileViewport() || location.protocol === 'file:');
      const inp = el('api-base-url');
      if (inp && !inp.value) inp.value = getApiBase();
    }
    if (!temServidorDisponivel()) {
      el('admin-offline').hidden = false;
      el('admin-login-box').hidden = true;
      el('admin-conteudo').hidden = true;
      el('btn-admin-logout').hidden = true;
      if (el('mob-btn-logout')) el('mob-btn-logout').hidden = true;
      return;
    }
    el('admin-offline').hidden = true;
    try {
      const st = await apiJson('/api/admin/status');
      adminAutenticado = Boolean(st.autenticado);
      atualizarVisaoAdmin(st.job);
    } catch (_) {
      adminAutenticado = false;
      if (getApiBase()) {
        el('admin-offline').hidden = false;
        el('admin-login-box').hidden = true;
        el('admin-conteudo').hidden = true;
        if (el('api-url-status')) el('api-url-status').textContent = 'Não foi possível alcançar o servidor configurado.';
      } else {
        atualizarVisaoAdmin(null);
      }
    }
  }

  function atualizarVisaoAdmin(job) {
    el('admin-login-box').hidden = adminAutenticado;
    el('admin-conteudo').hidden = !adminAutenticado;
    el('btn-admin-logout').hidden = !adminAutenticado;
    if (el('mob-btn-logout')) el('mob-btn-logout').hidden = !(adminAutenticado && pagina === 'admin');
    if (adminAutenticado) {
      if (job) renderJob(job);
      carregarConfigFontesUI();
      carregarParquetsUI();
      if (el('sessao-painel') && !el('atab-usuarios').hidden) carregarUsuariosUI();
    }
  }

  function editarUsuario(conta = null) {
    const form = el('form-usuario');
    form.reset();
    el('usuario-titulo').textContent = conta ? 'Editar usuário' : 'Novo usuário';
    el('usuario-nome').value = conta ? conta.nome : '';
    el('usuario-login').value = conta ? conta.usuario : '';
    el('usuario-login').readOnly = Boolean(conta);
    el('usuario-senha').required = !conta;
    el('usuario-senha-label').textContent = conta ? 'Nova senha' : 'Senha';
    el('usuario-senha-dica').textContent = conta ? 'Deixe em branco para manter a senha atual.' : 'Use pelo menos 12 caracteres.';
    el('usuario-ativo').checked = conta ? conta.ativo : true;
    el('usuario-salvar').textContent = conta ? 'Salvar alterações' : 'Criar conta';
    el('usuario-status').textContent = '';
  }

  async function carregarUsuariosUI() {
    try {
      const { usuarios } = await apiJson('/api/admin/usuarios');
      const lista = el('usuarios-lista');
      lista.replaceChildren();
      for (const conta of usuarios) {
        const linha = lista.insertRow();
        linha.insertCell().textContent = conta.nome;
        linha.insertCell().textContent = conta.usuario;
        const situacao = document.createElement('span');
        situacao.className = conta.ativo ? 'badge' : 'badge warn';
        situacao.textContent = conta.ativo ? 'Ativa' : 'Inativa';
        linha.insertCell().append(situacao);
        const acoes = linha.insertCell();
        if (conta.inicial) {
          acoes.textContent = 'Gerenciada no Railway';
        } else {
          const editar = document.createElement('button');
          editar.type = 'button';
          editar.className = 'btn secondary';
          editar.textContent = 'Editar';
          editar.setAttribute('aria-label', `Editar ${conta.usuario}`);
          editar.onclick = () => {
            editarUsuario(conta);
            el('usuario-nome').focus();
          };
          acoes.append(editar);
        }
      }
    } catch (erro) {
      el('usuario-status').textContent = erro.message;
    }
  }

  function renderJob(job) {
    if (!job) return;
    const badge = el('job-status-badge');
    const txt = el('job-status-text');
    const pre = el('job-logs');
    const mapa = {
      idle: ['Ocioso', 'neutral'],
      running: ['Executando…', 'info'],
      success: ['Concluído', ''],
      error: ['Erro', 'danger'],
    };
    const [rot, cls] = mapa[job.status] || ['Ocioso', 'neutral'];
    badge.textContent = rot;
    badge.className = `badge ${cls}`;
    txt.textContent = job.acao ? `Última ação: ${job.acao} · Início: ${job.inicio_utc || '—'}` : 'Aguardando comando.';
    if (job.logs && job.logs.length) {
      pre.textContent = job.logs.join('\n');
      pre.scrollTop = pre.scrollHeight;
    }
    const rodando = job.status === 'running';
    for (const id of ['btn-run-recalcular', 'btn-run-atualizar', 'btn-run-baixar']) el(id).disabled = rodando;

    if (rodando && !jobTimer) {
      jobTimer = setInterval(async () => {
        try {
          const j = await apiJson('/api/admin/job');
          renderJob(j);
          if (j.status !== 'running') {
            clearInterval(jobTimer);
            jobTimer = null;
            if (j.status === 'success') {
              await recarregarDadosInterface();
              await carregarParquetsUI();
            }
          }
        } catch (_) {
          clearInterval(jobTimer);
          jobTimer = null;
        }
      }, 1200);
    }
  }

  async function dispararPipeline(acao) {
    try {
      const payload = {
        acao,
        ano_inicial: Number(el('adm-ano-ini').value),
        ano_final: Number(el('adm-ano-fim').value),
        referencias_url: el('adm-ref-url').value.trim(),
      };
      const job = await apiJson('/api/admin/executar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      renderJob(job);
    } catch (erro) {
      el('job-logs').textContent = `Erro ao iniciar: ${erro.message}`;
    }
  }

  async function recarregarDadosInterface() {
    try {
      D = await apiJson('/api/dados');
      carregarSalvo();
      popularFiltrosGlobais();
      renderPaginaAtual();
    } catch (erro) {
      el('job-logs').textContent += `\nErro ao recarregar interface: ${erro.message}`;
    }
  }

  async function carregarConfigFontesUI() {
    try {
      const cfg = await apiJson('/api/admin/config-fontes');
      el('cfg-origem').value = cfg.origem_manutencoes || 'excel';
      el('cfg-excel-aba').value = cfg.excel_aba || 'Plano';
      el('cfg-excel-caminho').value = cfg.excel_caminho || '';
      const db = cfg.database || {};
      el('cfg-db-tipo').value = db.tipo || 'postgresql';
      el('cfg-db-host').value = db.host || '';
      el('cfg-db-porta').value = db.porta || 5432;
      el('cfg-db-banco').value = db.banco || '';
      el('cfg-db-schema').value = db.schema || 'public';
      el('cfg-db-tabela').value = db.tabela || '';
      el('cfg-db-usuario').value = db.usuario || '';
      el('cfg-db-senha-env').value = db.senha_env || 'CALC_ID_MANUT_DB_PASSWORD';
      el('cfg-db-arquivo').value = db.caminho_arquivo || '';
    } catch (_) {}
  }

  async function carregarParquetsUI() {
    try {
      const data = await apiJson('/api/admin/parquets');
      const grupos = new Map();
      for (const a of data.arquivos) {
        if (!grupos.has(a.categoria)) grupos.set(a.categoria, []);
        grupos.get(a.categoria).push(a);
      }
      let html = '';
      for (const [cat, itens] of grupos.entries()) {
        html += `<div class="pq-cat">${esc(cat)}</div>`;
        for (const a of itens) {
          const kb = (a.tamanho_bytes / 1024).toFixed(1);
          html += `<button class="pq-item ${pqAtual === a.caminho ? 'ativa' : ''}" data-pq="${esc(a.caminho)}">
            <strong>${esc(a.nome)}</strong>
            <small>${a.linhas ?? '?'} linhas · ${a.colunas ?? '?'} col · ${kb} KB</small>
          </button>`;
        }
      }
      el('lista-parquets').innerHTML = html || '<div class="empty-state">Nenhum Parquet encontrado.</div>';
    } catch (erro) {
      el('lista-parquets').innerHTML = `<div class="empty-state">${esc(erro.message)}</div>`;
    }
  }

  async function abrirPreviewParquet(caminho, offset = 0) {
    pqAtual = caminho;
    pqOffset = offset;
    for (const b of el('lista-parquets').querySelectorAll('.pq-item')) {
      b.classList.toggle('ativa', b.dataset.pq === caminho);
    }
    const filtro = el('pq-filtro').value.trim();
    const qs = new URLSearchParams({ caminho, limite: '50', offset: String(offset), filtro });
    try {
      const res = await apiJson(`/api/admin/parquet/preview?${qs}`);
      el('pq-titulo').textContent = res.nome;
      el('pq-meta').textContent = `${res.caminho} · ${res.total_filtrado} linhas${filtro ? ` (de ${res.total_linhas})` : ''}`;
      el('pq-download').href = `/api/admin/parquet/download?caminho=${encodeURIComponent(caminho)}`;
      el('pq-download').hidden = false;
      el('pq-esquema').innerHTML = res.esquema
        .map(c => `<span class="chip">${esc(c.coluna)}<em>${esc(c.tipo)}</em></span>`)
        .join('');
      tabela('tabela-parquet', res.colunas, res.linhas.map(row => row.map(v => (v === null ? '—' : esc(v)))));
      el('pq-paginacao').hidden = false;
      const ini = res.total_filtrado ? offset + 1 : 0;
      const fim = Math.min(offset + res.linhas.length, res.total_filtrado);
      el('pq-info').textContent = `Exibindo ${ini}–${fim} de ${res.total_filtrado}`;
      el('pq-prev').disabled = offset <= 0;
      el('pq-next').disabled = offset + res.limite >= res.total_filtrado;
    } catch (erro) {
      el('pq-meta').textContent = erro.message;
    }
  }

  async function executarSqlUI() {
    const sql = el('sql-editor').value;
    el('sql-erro').hidden = true;
    el('sql-meta').textContent = 'Executando…';
    try {
      const res = await apiJson('/api/admin/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, limite: 500 }),
      });
      el('sql-meta').textContent = `${res.quantidade} linhas${res.truncado ? ' (limitado a 500)' : ''} · ${res.duracao_ms} ms`;
      tabela('tabela-sql', res.colunas, res.linhas.map(row => row.map(v => (v === null ? '—' : esc(v)))));
    } catch (erro) {
      el('sql-erro').textContent = erro.message;
      el('sql-erro').hidden = false;
      el('sql-meta').textContent = '';
    }
  }

  // ==================== NAVEGAÇÃO & MOBILE UI ====================
  function abrirSheetFiltros(focoId = null) {
    el('sidebar').classList.add('open');
    if (el('mob-sheet-backdrop')) el('mob-sheet-backdrop').classList.add('open');
    document.body.classList.add('sheet-open');
    hapticTap();
    if (focoId) {
      const campo = el(focoId);
      const wrap = campo ? campo.closest('.sf-field, .sf-slider, .sf-checks') : null;
      if (wrap) {
        wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        wrap.classList.add('mob-highlight');
        setTimeout(() => wrap.classList.remove('mob-highlight'), 900);
      }
    }
  }

  function fecharSheetFiltros() {
    el('sidebar').classList.remove('open');
    if (el('mob-sheet-backdrop')) el('mob-sheet-backdrop').classList.remove('open');
    document.body.classList.remove('sheet-open');
  }

  function limparFiltrosPaginaAtual() {
    if (pagina === 'projecao') {
      el('proj-reset').click();
    } else if (pagina === 'manutencoes') {
      el('polo').value = '';
      popularSelectUsinas();
      el('usina').value = '';
      el('manut-tipo').value = '';
      if (el('manut-classificador')) el('manut-classificador').value = '';
      el('manut-status').value = 'plano';
      renderManutencoes();
    } else {
      el('polo').value = '';
      popularSelectUsinas();
      el('usina').value = '';
      if (pagina === 'atual') {
        const meses = [...new Set(D.mensal.map(r => mes(r.mes)))].sort().reverse();
        if (meses.length) el('mes-atual').value = meses[0];
      }
      renderPaginaAtual();
    }
    atualizarUiMobile();
    hapticTap();
  }

  function atualizarUiMobile() {
    const meta = PAGE_META[pagina] || PAGE_META.atual;
    if (el('mob-page-title')) el('mob-page-title').textContent = meta[2] || meta[1];

    // Subtitulo contextual na topbar mobile
    let sub = `Base ONS ${dataMes(D.mes_base)}`;
    if (pagina === 'atual') {
      const m = el('mes-atual').value;
      const uUnica = usinaAtual();
      sub = uUnica
        ? `${uUnica.usina} · 60m até ${dataMes(m)}`
        : `${usinasFiltradas().length} UHEs · 60m até ${dataMes(m)}`;
    } else if (pagina === 'simulacao') {
      const uUnica = usinaAtual();
      sub = uUnica
        ? `${uUnica.usina} · +${el('horizonte').value || 24} meses`
        : `Selecione uma usina · Base ${dataMes(D.mes_base)}`;
    } else if (pagina === 'manutencoes') {
      const ano = el('manut-ano').value || 'Todos anos';
      const uUnica = usinaAtual();
      sub = `${uUnica ? uUnica.usina : 'CTG Brasil'} · ${ano}`;
    } else if (pagina === 'projecao') {
      sub = `Corte ${dataMes(mesCorteProjecao())} · TEIFa ${numero(Number(el('fator-teif').value || 1), 2)}× · TEIP ${numero(Number(el('fator-teip').value || 1), 2)}×`;
    } else if (pagina === 'metodologia') {
      sub = 'ONS RO-AO.BR.04 · MME 709/2022';
    } else if (pagina === 'admin') {
      sub = adminAutenticado ? 'Sessão ativa' : (temServidorDisponivel() ? 'Acesso restrito' : 'Modo offline');
    }
    if (el('mob-page-sub')) el('mob-page-sub').textContent = sub;

    const temFiltros = pagina === 'atual' || pagina === 'simulacao' || pagina === 'manutencoes' || pagina === 'projecao';
    const btnFiltros = el('mob-btn-filtros');
    const strip = el('mob-filter-strip');
    if (btnFiltros) btnFiltros.hidden = !temFiltros;
    if (strip) strip.hidden = !temFiltros;
    if (el('mob-btn-admin')) el('mob-btn-admin').classList.toggle('ativa', pagina === 'admin');
    if (el('mob-btn-logout')) el('mob-btn-logout').hidden = !(adminAutenticado && pagina === 'admin');

    if (el('mob-sheet-title')) {
      el('mob-sheet-title').textContent = pagina === 'projecao' ? 'Filtros · Projeção ID Ref' : 'Filtros da Tela';
    }
    if (el('mob-sheet-sub')) {
      el('mob-sheet-sub').textContent = pagina === 'projecao'
        ? 'Ajuste data de corte, fatores de indisponibilidade e usinas de referência'
        : 'Selecione polo, usina e período de análise';
    }

    // Construir chips rapidos e contagem de filtros ativos
    const chips = [];
    let ativos = 0;

    if (pagina === 'atual' || pagina === 'simulacao' || pagina === 'manutencoes') {
      const poloVal = el('polo').value;
      const uSel = usinaAtual();
      if (poloVal) ativos++;
      if (uSel) ativos++;
      chips.push({
        id: 'polo',
        lbl: 'Polo',
        val: poloVal || 'Todos',
        active: Boolean(poloVal),
      });
      chips.push({
        id: 'usina',
        lbl: 'Usina',
        val: uSel ? uSel.usina : `Todas (${usinasFiltradas().length})`,
        active: Boolean(uSel),
      });
    }

    if (pagina === 'atual') {
      const m = el('mes-atual').value;
      const padrao = D.mes_base;
      const diff = Boolean(m && m !== padrao);
      if (diff) ativos++;
      chips.push({ id: 'mes-atual', lbl: 'Mês', val: dataMes(m), active: diff });
    } else if (pagina === 'simulacao') {
      const h = el('horizonte').value || '24';
      const diff = Number(h) !== 24;
      if (diff) ativos++;
      chips.push({ id: 'horizonte', lbl: 'Horizonte', val: `${h}m`, active: diff });
    } else if (pagina === 'manutencoes') {
      const ano = el('manut-ano').value;
      const tipo = el('manut-tipo').value;
      const cls = el('manut-classificador') ? el('manut-classificador').value : '';
      const st = el('manut-status').value;
      if (tipo) ativos++;
      if (cls) ativos++;
      if (st && st !== 'plano') ativos++;
      chips.push({ id: 'manut-ano', lbl: 'Ano', val: ano || 'Todos', active: Boolean(ano) });
      chips.push({ id: 'manut-tipo', lbl: 'Tipo', val: tipo || 'Todos', active: Boolean(tipo) });
      chips.push({ id: 'manut-classificador', lbl: 'Classif.', val: cls === 'SEM_CLASS' ? 'Vazio' : (cls || 'Todos'), active: Boolean(cls) });
      const stLblMap = { plano: 'No Plano', ativas: 'HDP > 0', expurgadas: 'Expurgadas', todas: 'Todas', canceladas: 'Canceladas' };
      chips.push({ id: 'manut-status', lbl: 'Status', val: stLblMap[st] || st, active: st !== 'plano' });
    } else if (pagina === 'projecao') {
      const corte = mesCorteProjecao();
      const padraoSin = (D.sin_meses && D.sin_meses[0]) || D.mes_base;
      const corteDiff = Boolean(corte && corte !== padraoSin);
      const ft = Number(el('fator-teif').value || 1);
      const fp = Number(el('fator-teip').value || 1);
      const c1 = el('chk-excluir-pimental').checked;
      const c2 = el('chk-excluir-belomonte').checked;
      const c3 = !el('chk-incluir-itaipu').checked;
      const overridesN = Object.keys(sinOverrides).length;
      if (corteDiff) ativos++;
      if (Math.abs(ft - 1) > 1e-6) ativos++;
      if (Math.abs(fp - 1) > 1e-6) ativos++;
      if (c1 || c2 || c3 || overridesN > 0) ativos++;
      chips.push({ id: 'proj-mes-corte', lbl: 'Corte', val: dataMes(corte), active: corteDiff });
      chips.push({ id: 'fator-teif', lbl: 'TEIFa', val: `${numero(ft, 2)}×`, active: Math.abs(ft - 1) > 1e-6 });
      chips.push({ id: 'fator-teip', lbl: 'TEIP', val: `${numero(fp, 2)}×`, active: Math.abs(fp - 1) > 1e-6 });
      const sinFlags = [c1 ? '−Pimental' : '', c2 ? '−B.Monte' : '', c3 ? '−Itaipu' : ''].filter(Boolean);
      chips.push({
        id: 'chk-excluir-pimental',
        lbl: 'Base SIN',
        val: sinFlags.length ? sinFlags.join(', ') : (overridesN ? `${overridesN} ajustes` : 'Padrão'),
        active: Boolean(sinFlags.length || overridesN),
      });
    }

    if (btnFiltros) btnFiltros.classList.toggle('has-active', ativos > 0);
    if (el('mob-filter-badge')) {
      el('mob-filter-badge').textContent = String(ativos);
      el('mob-filter-badge').hidden = ativos === 0;
    }
    if (el('mob-sheet-clear')) el('mob-sheet-clear').hidden = ativos === 0;

    if (el('mob-filter-chips')) {
      let html = chips
        .map(
          c =>
            `<button type="button" class="mob-chip ${c.active ? 'active' : ''}" data-focus-filter="${esc(c.id)}">` +
            `<span class="chip-lbl">${esc(c.lbl)}:</span>` +
            `<span class="chip-val">${esc(c.val)}</span>` +
            `<span class="chip-caret" aria-hidden="true">▾</span></button>`
        )
        .join('');
      if (ativos > 0) {
        html += `<button type="button" class="mob-chip chip-reset" data-reset-filters="1">✕ Limpar</button>`;
      }
      el('mob-filter-chips').innerHTML = html;
    }
  }

  function renderPaginaAtual() {
    if (pagina === 'atual') renderAtual();
    else if (pagina === 'simulacao') configurarSimulacao();
    else if (pagina === 'manutencoes') renderManutencoes();
    else if (pagina === 'projecao') renderProjecao();
    else if (pagina === 'metodologia') renderMetodologia();
    else if (pagina === 'admin') inicializarAdmin();
    atualizarUiMobile();
    requestAnimationFrame(resizeCharts);
  }

  function atualizarFiltrosSidebar(nome) {
    const temPoloUsina = nome === 'atual' || nome === 'simulacao' || nome === 'manutencoes';
    const mostrarBox = temPoloUsina || nome === 'projecao';
    el('sidebar-filters').hidden = !mostrarBox;
    el('sf-title').textContent = nome === 'projecao' ? 'Sensibilidade & Corte' : 'Filtros';
    el('sf-polo-usina').hidden = !temPoloUsina;
    el('sf-atual').hidden = nome !== 'atual';
    el('sf-simulacao').hidden = nome !== 'simulacao';
    el('sf-manutencoes').hidden = nome !== 'manutencoes';
    el('sf-projecao').hidden = nome !== 'projecao';
    el('periodo-atual').hidden = nome !== 'atual';
    if (nome !== 'admin') el('btn-admin-logout').hidden = true;
  }

  function trocarPagina(nome) {
    pagina = nome;
    const paginas = ['atual', 'simulacao', 'manutencoes', 'projecao', 'metodologia', 'admin'];
    for (const p of paginas) {
      el(p).hidden = p !== nome;
      for (const btnId of [`aba-${p}`, `mob-tab-${p}`]) {
        const btn = el(btnId);
        if (btn) {
          btn.classList.toggle('ativa', p === nome);
          if (p === nome) btn.setAttribute('aria-current', 'page');
          else btn.removeAttribute('aria-current');
        }
      }
    }
    const [, title] = PAGE_META[nome] || PAGE_META.atual;
    el('page-title').textContent = title;
    atualizarFiltrosSidebar(nome);
    fecharSheetFiltros();
    if (isMobileViewport()) window.scrollTo({ top: 0, behavior: 'instant' });
    hapticTap();
    renderPaginaAtual();
  }

  // Hook para o botao Voltar nativo do Android (Capacitor App plugin)
  window.__ctgHandleBack = () => {
    if (el('sidebar').classList.contains('open')) {
      fecharSheetFiltros();
      return true;
    }
    if (pagina !== 'atual') {
      trocarPagina('atual');
      return true;
    }
    return false;
  };

  // ==================== EVENTOS ====================
  for (const btn of document.querySelectorAll('[data-page]')) {
    btn.onclick = () => trocarPagina(btn.dataset.page);
  }
  el('btn-menu').onclick = () => {
    if (el('sidebar').classList.contains('open')) fecharSheetFiltros();
    else abrirSheetFiltros();
  };
  if (el('mob-btn-filtros')) el('mob-btn-filtros').onclick = () => abrirSheetFiltros();
  if (el('mob-sheet-close')) el('mob-sheet-close').onclick = () => fecharSheetFiltros();
  if (el('mob-sheet-apply')) el('mob-sheet-apply').onclick = () => fecharSheetFiltros();
  if (el('mob-sheet-backdrop')) el('mob-sheet-backdrop').onclick = () => fecharSheetFiltros();
  if (el('mob-sheet-clear')) el('mob-sheet-clear').onclick = () => limparFiltrosPaginaAtual();
  if (el('mob-btn-logout')) el('mob-btn-logout').onclick = () => el('btn-admin-logout').click();
  if (el('mob-filter-chips')) {
    el('mob-filter-chips').onclick = ev => {
      const resetBtn = ev.target.closest('[data-reset-filters]');
      if (resetBtn) {
        limparFiltrosPaginaAtual();
        return;
      }
      const chip = ev.target.closest('[data-focus-filter]');
      if (chip) abrirSheetFiltros(chip.dataset.focusFilter);
    };
  }
  // Gesto swipe-down para fechar o Bottom Sheet de filtros
  if (el('mob-sheet-head')) {
    let touchStartY = null;
    el('mob-sheet-head').addEventListener('touchstart', ev => {
      touchStartY = ev.touches[0].clientY;
    }, { passive: true });
    el('mob-sheet-head').addEventListener('touchend', ev => {
      if (touchStartY !== null && ev.changedTouches[0].clientY - touchStartY > 50) {
        fecharSheetFiltros();
      }
      touchStartY = null;
    }, { passive: true });
  }
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && el('sidebar').classList.contains('open')) fecharSheetFiltros();
  });

  if (el('btn-salvar-api-url')) {
    el('btn-salvar-api-url').onclick = async () => {
      const raw = (el('api-base-url').value || '').trim().replace(/\/+$/, '');
      if (!raw || !/^https?:\/\//i.test(raw)) {
        el('api-url-status').textContent = 'Informe uma URL válida começando com http:// ou https://.';
        return;
      }
      el('api-url-status').textContent = 'Testando conexão com servidor…';
      try {
        const res = await fetch(`${raw}/api/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        localStorage.setItem('ctg-api-base', raw);
        el('api-url-status').textContent = 'Conectado com sucesso!';
        inicializarAdmin();
      } catch (erro) {
        el('api-url-status').textContent = `Não foi possível conectar: ${erro.message}`;
      }
    };
  }
  if (el('btn-limpar-api-url')) {
    el('btn-limpar-api-url').onclick = () => {
      try { localStorage.removeItem('ctg-api-base'); } catch (_) {}
      if (el('api-base-url')) el('api-base-url').value = '';
      if (el('api-url-status')) el('api-url-status').textContent = 'Modo offline restaurado.';
      inicializarAdmin();
    };
  }

  el('polo').onchange = () => {
    popularSelectUsinas();
    renderPaginaAtual();
  };
  el('usina').onchange = () => renderPaginaAtual();
  el('mes-atual').onchange = () => { renderAtual(); atualizarUiMobile(); };

  for (const prefixo of ['atual', 'manut']) {
    if (el(`btn-${prefixo}-limpar`)) el(`btn-${prefixo}-limpar`).onclick = limparFiltroPoloUsina;
    if (el(`btn-${prefixo}-simular`)) {
      el(`btn-${prefixo}-simular`).onclick = () => {
        if (usinaAtual()) trocarPagina('simulacao');
      };
    }
  }

  // Clique em linha da tabela atual para selecionar usina
  el('tabela-atual').onclick = ev => {
    const tr = ev.target.closest('tr[data-ceg]');
    if (!tr) return;
    el('usina').value = tr.dataset.ceg;
    renderAtual();
    atualizarUiMobile();
  };

  // Toggles de metricas dos graficos
  el('toggle-metrica-atual').onclick = ev => {
    const b = ev.target.closest('button[data-metric]');
    if (!b) return;
    metricaAtual = b.dataset.metric;
    for (const x of el('toggle-metrica-atual').querySelectorAll('button')) x.classList.toggle('ativa', x === b);
    renderAtual();
  };
  el('toggle-metrica-sim').onclick = ev => {
    const b = ev.target.closest('button[data-metric]');
    if (!b) return;
    metricaSim = b.dataset.metric;
    for (const x of el('toggle-metrica-sim').querySelectorAll('button')) x.classList.toggle('ativa', x === b);
    renderSimulacao();
  };

  // Simulador eventos
  el('horizonte').onchange = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    const n = Number(el('horizonte').value);
    if (!Number.isInteger(n) || n < 1 || n > 120) { el('horizonte').value = e.horizonte; return; }
    e.horizonte = n;
    reconstruirEdicoesComSimuladas(u, e);
    guardar();
    configurarSimulacao();
    atualizarUiMobile();
  };
  el('id-referencia').oninput = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    e.idRef = el('id-referencia').value === '' ? null : Number(el('id-referencia').value) / 100;
    guardar();
    renderSimulacao();
  };
  el('restaurar-referencia').onclick = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    e.idRef = u.id_referencia;
    guardar();
    configurarSimulacao();
  };
  el('usar-ref-2028').onclick = () => {
    const u = usinaAtual();
    if (!u) return;
    const fx = (D.projecao_faixas || []).find(f => f.faixa === u.faixa);
    if (!fx || !fx.id_proj_2028_pct) return;
    const e = estadoSim(u.cod_ceg);
    e.idRef = fx.id_proj_2028_pct / 100;
    guardar();
    configurarSimulacao();
  };
  el('mes-edicao').onchange = () => renderEditor();
  el('limpar-mes').onclick = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    const prefix = el('mes-edicao').value + '|';
    for (const k of Object.keys(e.edicoes)) if (k.startsWith(prefix)) delete e.edicoes[k];
    guardar();
    renderEditor();
    renderSimulacao();
  };
  el('btn-carregar-plano').onclick = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    e.baseModo = 'plano';
    e.simuladas = [];
    reconstruirEdicoesComSimuladas(u, e);
    guardar();
    renderTabelaSimuladas();
    atualizarBadgeCenariosSalvos();
    renderEditor();
    renderSimulacao();
  };
  if (el('chk-sim-expurgo')) {
    el('chk-sim-expurgo').onchange = () => {
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      e.aplicarExpurgos = el('chk-sim-expurgo').checked;
      reconstruirEdicoesComSimuladas(u, e);
      guardar();
      renderTabelaSimuladas();
      renderEditor();
      renderSimulacao();
    };
  }
  el('btn-zerar-tudo').onclick = () => {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    e.baseModo = 'zero';
    e.simuladas = [];
    e.edicoes = {};
    guardar();
    renderTabelaSimuladas();
    atualizarBadgeCenariosSalvos();
    renderEditor();
    renderSimulacao();
  };
  // ===== MODAL DE MANUTENÇÃO / ESTRESSE SIMULADO (SOMENTE SIMULAÇÃO FID) =====
  const CHECK_SVG =
    '<svg class="cselect-check-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  let simModalUgsDisponiveis = [];
  let simModalUgsSelecionadas = new Set();
  let simModalEditId = null;
  const simSelectOpcoes = {};

  function reconstruirEdicoesComSimuladas(u, e) {
    const aplicarExp = e.aplicarExpurgos !== false;
    const edicoes =
      e.baseModo === 'zero'
        ? {}
        : M.construirEdicoesPlano(D, u.cod_ceg, e.horizonte, { aplicarExpurgos: aplicarExp });
    const mesMin = M.moverMes(D.mes_base, 1);
    const mesMax = M.moverMes(D.mes_base, e.horizonte);
    const ordemCampos = ['HDF', 'HEDF', 'HDP', 'HEDP', 'HDCE', 'HRD'];

    for (const ev of e.simuladas || []) {
      let rateio;
      try {
        rateio = M.ratearManutencaoSimulada(ev, { aplicarExpurgos: aplicarExp, mesMin, mesMax });
      } catch (_) {
        continue;
      }
      for (const item of rateio.meses) {
        const hp = M.horasMes(item.mes);
        for (const ugNum of ev.ugs || []) {
          const k = `${item.mes}|${ugNum}`;
          if (!edicoes[k]) edicoes[k] = {};
          for (const campo of ordemCampos) {
            const add = item[campo] || 0;
            if (add <= 0) continue;
            const atualTipo = edicoes[k][campo] || 0;
            const outras = M.CAMPOS.filter(c => c !== campo).reduce((s, c) => s + (edicoes[k][c] || 0), 0);
            const excesso = atualTipo + add + outras - hp;
            if (excesso > 0 && campo !== 'HRD' && (edicoes[k].HRD || 0) > 0) {
              edicoes[k].HRD = Number(Math.max(0, edicoes[k].HRD - excesso).toFixed(2));
            }
            const outrasPos = M.CAMPOS.filter(c => c !== campo).reduce((s, c) => s + (edicoes[k][c] || 0), 0);
            edicoes[k][campo] = Number(Math.min(Math.max(0, hp - outrasPos), atualTipo + add).toFixed(2));
          }
        }
      }
    }
    e.edicoes = edicoes;
  }

  function formatarUgsResumo(ugsArr, totalUgs) {
    const ord = [...(ugsArr || [])].sort((a, b) => a - b);
    if (!ord.length) return '—';
    if (totalUgs && ord.length === totalUgs) return `Todas (${ord.length})`;
    if (ord.length <= 3) return ord.map(n => `UG${String(n).padStart(2, '0')}`).join(', ');
    return `${ord.length} UGs (${ord.slice(0, 2).map(n => `UG${String(n).padStart(2, '0')}`).join(', ')}…)`;
  }

  function renderTabelaSimuladas() {
    const u = usinaAtual();
    const tbl = el('tabela-sim-manutencoes');
    if (!u || !tbl) return;
    const e = estadoSim(u.cod_ceg);
    const lista = e.simuladas || [];
    const totalUgs = D.horas.filter(r => r.cod_ceg === u.cod_ceg && mes(r.data) === D.mes_base).length;
    const mesMin = M.moverMes(D.mes_base, 1);
    const mesMax = M.moverMes(D.mes_base, e.horizonte);
    const aplicarExp = e.aplicarExpurgos !== false;

    const btnLimpar = el('btn-sim-limpar-eventos');
    const btnEfetivar = el('btn-sim-efetivar-real');
    const resumo = el('sim-manut-resumo');
    if (btnLimpar) btnLimpar.hidden = lista.length === 0;
    if (btnEfetivar) btnEfetivar.disabled = lista.length === 0;

    if (!lista.length) {
      if (resumo) {
        resumo.textContent = 'Nenhuma manutenção incluída neste cenário. Use "+ Configurar Manutenção / Estresse Simulado" ou "+ Incluir Evento" para testar novas paradas.';
      }
      tabela(
        'tabela-sim-manutencoes',
        ['UGs', 'Tipo', 'Classif.', 'Estágio', 'Início', 'Término', 'Dias', 'Ret. Diário', 'Bruto (h)', 'Expurgo (h)', 'Indisp. Líq. (h)', 'Destino ONS', 'Descrição', 'Ações'],
        []
      );
      return;
    }

    const totalUgsEventos = lista.reduce((s, ev) => s + (ev.ugs?.length || 0), 0);
    if (resumo) {
      resumo.textContent = `${lista.length} ${lista.length === 1 ? 'inclusão simulada' : 'inclusões simuladas'} (${totalUgsEventos} registro${totalUgsEventos === 1 ? '' : 's'} UG) · Somente no cenário ativo até efetivação.`;
    }

    tabela(
      'tabela-sim-manutencoes',
      ['UGs', 'Tipo', 'Classif.', 'Estágio', 'Início', 'Término', 'Dias', 'Ret. Diário', 'Bruto (h)', 'Expurgo (h)', 'Indisp. Líq. (h)', 'Destino ONS', 'Descrição', 'Ações'],
      lista.map(ev => {
        let r = null;
        try {
          r = M.ratearManutencaoSimulada(ev, { aplicarExpurgos: aplicarExp, mesMin, mesMax });
        } catch (_) {}
        const infoCls = infoClassificadorModal(ev.classificador);
        const corTipo = TIPO_COR[ev.tipo_manut] || '#475569';
        const dest = r ? r.destino_ons : ev.campo_impacto || 'HDP';
        const destCls = dest === 'HRD' ? '' : dest === 'HDCE' ? 'info' : dest === 'HDP' ? 'warn' : dest.includes('HDF') ? 'danger' : 'neutral';
        const bruto = r ? r.horas_brutas : Number(ev.horas_brutas) || 0;
        const expH = r ? r.expurgo_horas : 0;
        const liqH = r ? r.indisponibilidade_horas : bruto;
        const dias = r ? r.duracao_dias : diffDiasInclusivo(ev.data_inicio, ev.data_fim) || '—';
        return [
          `<strong>${esc(formatarUgsResumo(ev.ugs, totalUgs))}</strong>`,
          `<span class="badge info" style="background:${corTipo}20;color:${corTipo}">${esc(ev.tipo_manut || 'OUTROS')}</span>`,
          badgeClassificador(ev.classificador, infoCls?.grupo_ons),
          `<span class="badge ${ev.estagio === 'Executado' ? '' : ev.estagio === 'Reprogramado' ? 'warn' : 'neutral'}">${esc(ev.estagio || 'Planejado')}</span>`,
          dataDia(ev.data_inicio),
          dataDia(ev.data_fim),
          dias,
          ev.retorno_diario ? 'Sim (12h)' : 'Não (24h)',
          numero(bruto, 1),
          expH > 0 ? `<span class="num-pos">${numero(expH, 1)}</span>` : '0,0',
          `<strong>${numero(liqH, 1)}</strong>`,
          `<span class="badge ${destCls}">${esc(dest)}</span>`,
          { html: esc(ev.descricao || '—'), cls: 'text-left' },
          `<div class="sim-row-actions">
            <button type="button" class="btn secondary btn-xs" data-sim-edit="${esc(ev.id)}">Editar</button>
            <button type="button" class="btn btn-xs danger-outline" data-sim-del="${esc(ev.id)}">Excluir</button>
          </div>`,
        ];
      })
    );
  }

  function isoDataUtc(dt) {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
  }
  function somarDiasIso(iso, delta) {
    const dt = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return '';
    dt.setUTCDate(dt.getUTCDate() + delta);
    return isoDataUtc(dt);
  }
  function diffDiasInclusivo(iniIso, fimIso) {
    const d1 = new Date(`${String(iniIso).slice(0, 10)}T00:00:00Z`);
    const d2 = new Date(`${String(fimIso).slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
    return Math.round((d2.getTime() - d1.getTime()) / 86400000) + 1;
  }
  function infoClassificadorModal(codigo) {
    const sig = String(codigo || '').trim().toUpperCase();
    return (D.classificadores_ons || []).find(c => c.codigo === sig) || null;
  }
  function destinoExpurgoModal(codigo) {
    const info = infoClassificadorModal(codigo);
    return info && info.destino_expurgo === 'HDCE' ? 'HDCE' : 'HRD';
  }

  function fecharMenusCselect(excetoWrap = null) {
    document.querySelectorAll('#modal-sim-manut .cselect.open').forEach(wrap => {
      if (wrap === excetoWrap) return;
      wrap.classList.remove('open');
      const btn = wrap.querySelector('.cselect-trigger');
      const menu = wrap.querySelector('.cselect-menu');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (menu) menu.hidden = true;
    });
  }
  function posicionarMenuCselect(wrap) {
    const btn = wrap.querySelector('.cselect-trigger');
    const menu = wrap.querySelector('.cselect-menu');
    if (!btn || !menu) return;
    const rect = btn.getBoundingClientRect();
    const minW = wrap.id === 'cs-sim-classificador' ? Math.max(rect.width, 320) : rect.width;
    const width = Math.min(minW, window.innerWidth - 20);
    let left = rect.left;
    if (left + width > window.innerWidth - 10) {
      left = Math.max(10, window.innerWidth - width - 10);
    }
    const espacoAbaixo = window.innerHeight - rect.bottom - 12;
    const espacoAcima = rect.top - 12;
    const abrirAcima = espacoAbaixo < 200 && espacoAcima > espacoAbaixo;
    const maxH = Math.max(120, Math.min(260, abrirAcima ? espacoAcima : espacoAbaixo));
    menu.style.width = `${width}px`;
    menu.style.left = `${left}px`;
    menu.style.maxHeight = `${maxH}px`;
    if (abrirAcima) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom + 5}px`;
    }
  }
  function alternarMenuCselect(wrap) {
    if (!wrap) return;
    const estavaAberto = wrap.classList.contains('open');
    fecharMenusCselect();
    if (estavaAberto) return;
    const btn = wrap.querySelector('.cselect-trigger');
    const menu = wrap.querySelector('.cselect-menu');
    if (!btn || !menu) return;
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    posicionarMenuCselect(wrap);
  }

  function configurarCselectSimples(inputId, wrapId, opcoes, aoMudar) {
    simSelectOpcoes[inputId] = opcoes;
    const wrap = el(wrapId);
    const input = el(inputId);
    if (!wrap || !input) return;
    const menu = wrap.querySelector('.cselect-menu');
    menu.innerHTML = opcoes
      .map(
        o =>
          `<button type="button" class="cselect-option" role="option" data-val="${esc(o.value)}">
            <span class="cselect-opt-main">${o.html}</span>
            ${o.sub ? `<span class="cselect-opt-sub">${esc(o.sub)}</span>` : ''}
            ${CHECK_SVG}
          </button>`
      )
      .join('');
    menu.onclick = ev => {
      const btnOpt = ev.target.closest('.cselect-option');
      if (!btnOpt) return;
      definirValorCselect(inputId, wrapId, btnOpt.dataset.val);
      fecharMenusCselect();
      if (aoMudar) aoMudar(btnOpt.dataset.val);
    };
  }
  function definirValorCselect(inputId, wrapId, valor) {
    const input = el(inputId);
    const wrap = el(wrapId);
    if (!input || !wrap) return;
    input.value = valor;
    const opcoes = simSelectOpcoes[inputId] || [];
    const atual = opcoes.find(o => o.value === valor) || opcoes[0];
    const valEl = wrap.querySelector('.cselect-value');
    if (valEl && atual) {
      valEl.innerHTML = atual.triggerHtml || atual.html;
    }
    wrap.querySelectorAll('.cselect-option').forEach(opt => {
      const sel = opt.dataset.val === valor;
      opt.classList.toggle('selected', sel);
      opt.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
  }

  function renderMultiselectUg() {
    const wrap = el('cs-sim-ug');
    const menu = el('sim-manut-ug-menu');
    const valEl = wrap?.querySelector('.cselect-value');
    if (!wrap || !menu || !valEl) return;

    const total = simModalUgsDisponiveis.length;
    const qtd = simModalUgsSelecionadas.size;
    const todasMarcadas = total > 0 && qtd === total;

    if (qtd === 0) {
      valEl.innerHTML = '<span class="cselect-value-muted">Selecione ao menos 1 UG</span>';
    } else if (todasMarcadas) {
      valEl.innerHTML = `<span class="badge cselect-pill-sm">Todas</span><span class="cselect-value-text">${total} UGs selecionadas</span>`;
    } else if (qtd <= 3) {
      const nomes = [...simModalUgsSelecionadas]
        .sort((a, b) => a - b)
        .map(n => `UG ${String(n).padStart(2, '0')}`)
        .join(', ');
      valEl.innerHTML = `<span class="badge info cselect-pill-sm">${qtd}</span><span class="cselect-value-text">${esc(nomes)}</span>`;
    } else {
      valEl.innerHTML = `<span class="badge info cselect-pill-sm">${qtd} / ${total}</span><span class="cselect-value-text">${qtd} UGs selecionadas</span>`;
    }

    menu.innerHTML =
      `<div class="cselect-multi-head">
        <label class="cselect-multi-all">
          <input type="checkbox" data-ug-all="1" ${todasMarcadas ? 'checked' : ''}>
          <span>Todas as UGs</span>
        </label>
        <span class="cselect-multi-count">${qtd}/${total}</span>
      </div>` +
      simModalUgsDisponiveis
        .map(g => {
          const checked = simModalUgsSelecionadas.has(g.ug);
          return `<label class="cselect-multi-item ${checked ? 'selected' : ''}">
            <span class="cselect-multi-left">
              <input type="checkbox" data-ug-num="${g.ug}" ${checked ? 'checked' : ''}>
              <span>UG ${String(g.ug).padStart(2, '0')}</span>
            </span>
            <span class="cselect-mw">${numero(g.potencia_ug_mw, 1)} MW</span>
          </label>`;
        })
        .join('');
    const chkAll = menu.querySelector('input[data-ug-all]');
    if (chkAll) chkAll.indeterminate = qtd > 0 && qtd < total;
  }

  function atualizarRotuloExpurgoModal() {
    const chk = el('sim-manut-expurgada');
    const inp = el('sim-manut-expurgo-h');
    const lbl = el('sim-manut-expurgada-lbl');
    if (!chk || !inp || !lbl) return;
    inp.disabled = !chk.checked;
    if (chk.checked) {
      const dest = destinoExpurgoModal(el('sim-manut-classificador').value);
      lbl.textContent = `Sim (Expurgo → ${dest})`;
    } else {
      lbl.textContent = 'Não (impacta taxas)';
    }
  }
  function lerEventoModalStress() {
    const cls = el('sim-manut-classificador').value;
    return {
      ugs: [...simModalUgsSelecionadas].sort((a, b) => a - b),
      estagio: el('sim-manut-estagio').value,
      tipo_manut: el('sim-manut-tipo').value,
      classificador: cls,
      campo_impacto: el('sim-manut-param').value,
      data_inicio: el('sim-manut-inicio').value,
      data_fim: el('sim-manut-fim').value,
      retorno_diario: el('sim-manut-retorno').value === 'sim',
      horas_brutas: el('sim-manut-bruto').value === '' ? null : Number(el('sim-manut-bruto').value),
      expurgada: el('sim-manut-expurgada').checked,
      expurgo_horas: el('sim-manut-expurgada').checked ? Number(el('sim-manut-expurgo-h').value) || 0 : 0,
      destino_expurgo: destinoExpurgoModal(cls),
      descricao: (el('sim-manut-desc').value || '').trim(),
    };
  }
  function atualizarPreviewModalStress() {
    const u = usinaAtual();
    const box = el('sim-manut-preview');
    const err = el('sim-manut-erro');
    const btn = el('btn-aplicar-modal-stress');
    if (!u || !box || !err || !btn) return;
    atualizarRotuloExpurgoModal();
    const e = estadoSim(u.cod_ceg);
    const mesMin = M.moverMes(D.mes_base, 1);
    const mesMax = M.moverMes(D.mes_base, e.horizonte);
    const ev = lerEventoModalStress();
    if (!ev.ugs.length) {
      box.innerHTML = '';
      err.textContent = 'Selecione ao menos uma UG para aplicar na simulação.';
      err.hidden = false;
      btn.disabled = true;
      return;
    }
    try {
      const r = M.ratearManutencaoSimulada(ev, {
        aplicarExpurgos: e.aplicarExpurgos !== false,
        mesMin,
        mesMax,
      });
      const destCls =
        r.destino_ons === 'HRD' ? '' : r.destino_ons === 'HDCE' ? 'info' : r.destino_ons === 'HDP' ? 'warn' : 'neutral';
      const resumoUgs =
        ev.ugs.length === simModalUgsDisponiveis.length
          ? `Todas as UGs (${ev.ugs.length})`
          : ev.ugs.length <= 4
          ? ev.ugs.map(n => `UG ${String(n).padStart(2, '0')}`).join(', ')
          : `${ev.ugs.length} UGs selecionadas`;
      const resumoMeses = r.meses
        .map(m => {
          const partes = M.CAMPOS.filter(c => (m[c] || 0) > 0).map(c => `${numero(m[c], 1)} h ${c}`);
          return `<strong>${dataMes(m.mes)}</strong> (${partes.join(' + ')})`;
        })
        .join(' · ');
      const avisoFora =
        r.dias_fora_horizonte > 0
          ? `<div class="modal-preview-meta modal-preview-warn">Atenção: ${r.dias_fora_horizonte} dia(s) estão fora do horizonte atual (${dataMes(mesMin)} a ${dataMes(mesMax)}) e não serão aplicados.</div>`
          : '';
      const avisoExpOff =
        ev.expurgada && ev.expurgo_horas > 0 && e.aplicarExpurgos === false
          ? '<div class="modal-preview-meta modal-preview-warn">A opção "Aplicar expurgos ONS" está desmarcada no simulador; todas as horas entrarão no parâmetro de impacto.</div>'
          : '';
      box.innerHTML = `
        <div class="modal-preview-grid">
          <div class="modal-preview-item"><span>Bruto (h/UG)</span><strong>${numero(r.horas_brutas, 1)} h</strong></div>
          <div class="modal-preview-item"><span>Expurgo (h/UG)</span><strong class="${r.expurgo_horas > 0 ? 'num-pos' : ''}">${numero(r.expurgo_horas, 1)} h</strong></div>
          <div class="modal-preview-item"><span>${esc(r.campo_impacto)} Líq. (h/UG)</span><strong>${numero(r.indisponibilidade_horas, 1)} h</strong></div>
          <div class="modal-preview-item"><span>Destino ONS</span><div><span class="badge ${destCls}">${esc(r.destino_ons)}</span></div></div>
        </div>
        <div class="modal-preview-meta">
          <strong>Escopo:</strong> ${esc(resumoUgs)} &nbsp;·&nbsp;
          ${r.meses.length ? `Rateio (${r.duracao_dias} dia${r.duracao_dias === 1 ? '' : 's'}): ${resumoMeses}` : 'Nenhum dia dentro do horizonte simulado.'}
        </div>
        ${avisoFora}${avisoExpOff}`;
      if (!r.meses.length) {
        err.textContent = `O período informado está totalmente fora do horizonte atual (${dataMes(mesMin)} a ${dataMes(mesMax)}). Ajuste as datas ou aumente o horizonte.`;
        err.hidden = false;
        btn.disabled = true;
      } else {
        err.hidden = true;
        btn.disabled = false;
      }
    } catch (erro) {
      box.innerHTML = '';
      err.textContent = erro.message;
      err.hidden = false;
      btn.disabled = true;
    }
  }
  function aoMudarClassificadorModal(cls) {
    const info = infoClassificadorModal(cls);
    const bruto = Number(el('sim-manut-bruto').value) || 0;
    if (info && info.codigo === 'GRH' && el('sim-manut-param').value === 'HDP') {
      definirValorCselect('sim-manut-param', 'cs-sim-param', 'HEDP');
    }
    if (info && (info.expurgo_integral || info.grupo_ons === '7.1.3.2' || info.grupo_ons === '7.1.3.3')) {
      el('sim-manut-expurgada').checked = true;
      el('sim-manut-expurgo-h').disabled = false;
      el('sim-manut-expurgo-h').value = String(bruto);
    } else {
      el('sim-manut-expurgada').checked = false;
      el('sim-manut-expurgo-h').disabled = true;
      el('sim-manut-expurgo-h').value = '0';
    }
    atualizarPreviewModalStress();
  }
  function abrirModalStress(eventoEditar = null) {
    const u = usinaAtual();
    const modal = el('modal-sim-manut');
    if (!u || !modal) return;
    const e = estadoSim(u.cod_ceg);
    simModalEditId = eventoEditar && eventoEditar.id ? eventoEditar.id : null;
    const editando = Boolean(simModalEditId);

    if (el('modal-sim-titulo')) {
      el('modal-sim-titulo').textContent = editando
        ? 'Editar Manutenção Simulada'
        : 'Configurar Manutenção / Estresse Simulado';
    }
    if (el('btn-aplicar-modal-stress')) {
      el('btn-aplicar-modal-stress').textContent = editando
        ? 'Salvar Alterações na Simulação'
        : '+ Aplicar na Simulação';
    }

    simModalUgsDisponiveis = D.horas.filter(r => r.cod_ceg === u.cod_ceg && mes(r.data) === D.mes_base);
    if (editando && Array.isArray(eventoEditar.ugs) && eventoEditar.ugs.length) {
      const validos = new Set(simModalUgsDisponiveis.map(g => g.ug));
      simModalUgsSelecionadas = new Set(eventoEditar.ugs.filter(n => validos.has(n)));
    } else {
      simModalUgsSelecionadas = new Set(simModalUgsDisponiveis.map(g => g.ug));
    }

    el('sim-manut-usina').value = `${u.usina} · ${u.polo}`;
    renderMultiselectUg();

    configurarCselectSimples(
      'sim-manut-estagio',
      'cs-sim-estagio',
      [
        { value: 'Planejado', html: '<span class="badge neutral cselect-pill-sm">Planejado</span>' },
        { value: 'Programado', html: '<span class="badge info cselect-pill-sm">Programado</span>' },
        { value: 'Reprogramado', html: '<span class="badge warn cselect-pill-sm">Reprogramado</span>' },
        { value: 'Executado', html: '<span class="badge cselect-pill-sm">Executado</span>' },
      ],
      () => atualizarPreviewModalStress()
    );
    definirValorCselect('sim-manut-estagio', 'cs-sim-estagio', editando ? (eventoEditar.estagio || 'Planejado') : 'Planejado');

    const tiposPadrao = ['MPP0', 'MPP1', 'MPP2', 'MOD', 'MPAIE', 'PRED', 'C. PROG', 'CSEG', 'BS', 'CORR', 'OUTROS'];
    const tiposDados = (D.manutencoes || []).map(m => m.tipo_manut).filter(Boolean);
    const tiposUnicos = [...new Set([...tiposPadrao, ...tiposDados])];
    configurarCselectSimples(
      'sim-manut-tipo',
      'cs-sim-tipo',
      tiposUnicos.map(t => {
        const cor = TIPO_COR[t] || '#475569';
        const pill = `<span class="badge info cselect-pill-sm" style="background:${cor}20;color:${cor}">${esc(t)}</span>`;
        return { value: t, html: pill, triggerHtml: pill };
      }),
      () => atualizarPreviewModalStress()
    );
    const tipoIni = editando && tiposUnicos.includes(eventoEditar.tipo_manut)
      ? eventoEditar.tipo_manut
      : (tiposUnicos.includes('MPP1') ? 'MPP1' : tiposUnicos[0]);
    definirValorCselect('sim-manut-tipo', 'cs-sim-tipo', tipoIni);

    const classifsUhe = (D.classificadores_ons || []).filter(c => c.aplica_uhe !== false);
    configurarCselectSimples(
      'sim-manut-classificador',
      'cs-sim-classificador',
      [
        ...classifsUhe.map(c => ({
          value: c.codigo,
          html: `${badgeClassificador(c.codigo, c.grupo_ons)}<span class="cselect-opt-text">${esc(c.nome)}</span>`,
          triggerHtml: `${badgeClassificador(c.codigo, c.grupo_ons)}<span class="cselect-value-text">${esc(c.nome)}</span>`,
        })),
        {
          value: '',
          html: '<span class="badge neutral cselect-pill-sm">—</span><span class="cselect-opt-text">Sem classificador (HDP)</span>',
          triggerHtml: '<span class="badge neutral cselect-pill-sm">—</span><span class="cselect-value-text">Sem classificador</span>',
        },
      ],
      val => aoMudarClassificadorModal(val)
    );
    definirValorCselect('sim-manut-classificador', 'cs-sim-classificador', editando ? (eventoEditar.classificador ?? '') : 'GUM');

    configurarCselectSimples(
      'sim-manut-param',
      'cs-sim-param',
      [
        { value: 'HDP', html: '<span class="badge warn cselect-pill-sm">HDP</span><span class="cselect-opt-text">Programada</span>' },
        { value: 'HDF', html: '<span class="badge danger cselect-pill-sm">HDF</span><span class="cselect-opt-text">Forçada</span>' },
        { value: 'HEDP', html: '<span class="badge warn cselect-pill-sm">HEDP</span><span class="cselect-opt-text">Restr. Programada</span>' },
        { value: 'HEDF', html: '<span class="badge danger cselect-pill-sm">HEDF</span><span class="cselect-opt-text">Restr. Forçada</span>' },
      ],
      () => atualizarPreviewModalStress()
    );
    definirValorCselect('sim-manut-param', 'cs-sim-param', editando ? (eventoEditar.campo_impacto || 'HDP') : 'HDP');

    configurarCselectSimples(
      'sim-manut-retorno',
      'cs-sim-retorno',
      [
        { value: 'nao', html: '<span class="cselect-opt-text">Não</span>', sub: '24h/dia', triggerHtml: '<span class="cselect-value-text">Não (24h/dia)</span>' },
        { value: 'sim', html: '<span class="cselect-opt-text">Sim</span>', sub: '12h/dia', triggerHtml: '<span class="cselect-value-text">Sim (12h/dia)</span>' },
      ],
      () => {
        const dias = Math.max(1, parseInt(el('sim-manut-dias').value, 10) || 1);
        sincronizarHorasPorDias(dias);
        atualizarPreviewModalStress();
      }
    );
    definirValorCselect('sim-manut-retorno', 'cs-sim-retorno', editando && eventoEditar.retorno_diario ? 'sim' : 'nao');

    const mSel = el('mes-edicao').value || M.moverMes(D.mes_base, 1);
    const [anoM, numM] = mSel.split('-').map(Number);
    const diasMes = new Date(Date.UTC(anoM, numM, 0)).getUTCDate();
    const diasPadrao = Math.min(10, diasMes);
    const iniIso = editando && eventoEditar.data_inicio ? eventoEditar.data_inicio : `${mSel}-01`;
    const fimIso = editando && eventoEditar.data_fim ? eventoEditar.data_fim : `${mSel}-${String(diasPadrao).padStart(2, '0')}`;
    const diasIni = diffDiasInclusivo(iniIso, fimIso) || diasPadrao;
    const mesMin = M.moverMes(D.mes_base, 1);
    const mesMax = M.moverMes(D.mes_base, e.horizonte);
    const [anoMax, numMax] = mesMax.split('-').map(Number);
    const ultDiaMax = new Date(Date.UTC(anoMax, numMax, 0)).getUTCDate();

    el('sim-manut-inicio').min = `${mesMin}-01`;
    el('sim-manut-inicio').max = `${mesMax}-${String(ultDiaMax).padStart(2, '0')}`;
    el('sim-manut-fim').min = `${mesMin}-01`;
    el('sim-manut-fim').max = `${mesMax}-${String(ultDiaMax).padStart(2, '0')}`;
    el('sim-manut-inicio').value = iniIso;
    el('sim-manut-fim').value = fimIso;
    el('sim-manut-dias').value = String(diasIni);
    el('sim-manut-bruto').value = String(editando && Number.isFinite(eventoEditar.horas_brutas) ? eventoEditar.horas_brutas : diasIni * 24);
    el('sim-manut-expurgada').checked = Boolean(editando && eventoEditar.expurgada);
    el('sim-manut-expurgo-h').value = String(editando && eventoEditar.expurgada ? (eventoEditar.expurgo_horas ?? 0) : 0);
    el('sim-manut-expurgo-h').disabled = !el('sim-manut-expurgada').checked;
    el('sim-manut-desc').value = editando ? (eventoEditar.descricao || '') : '';

    fecharMenusCselect();
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    atualizarPreviewModalStress();
    el('sim-manut-ug-btn')?.focus();
  }
  function fecharModalStress() {
    fecharMenusCselect();
    simModalEditId = null;
    const modal = el('modal-sim-manut');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  if (el('btn-abrir-modal-stress')) {
    el('btn-abrir-modal-stress').onclick = () => abrirModalStress(null);
  }
  if (el('btn-sim-incluir-evento')) {
    el('btn-sim-incluir-evento').onclick = () => abrirModalStress(null);
  }
  if (el('btn-fechar-modal-stress')) {
    el('btn-fechar-modal-stress').onclick = fecharModalStress;
  }
  if (el('btn-cancelar-modal-stress')) {
    el('btn-cancelar-modal-stress').onclick = fecharModalStress;
  }
  if (el('btn-ir-paradas-modal')) {
    el('btn-ir-paradas-modal').onclick = () => {
      fecharModalStress();
      irPara('manutencoes');
    };
  }
  if (el('modal-sim-manut')) {
    document.querySelectorAll('#modal-sim-manut .cselect-trigger').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        alternarMenuCselect(btn.closest('.cselect'));
      });
    });
    if (el('sim-manut-ug-menu')) {
      el('sim-manut-ug-menu').addEventListener('change', ev => {
        const alvo = ev.target;
        if (!alvo.matches('input[type="checkbox"]')) return;
        if (alvo.dataset.ugAll) {
          if (alvo.checked) {
            simModalUgsSelecionadas = new Set(simModalUgsDisponiveis.map(g => g.ug));
          } else {
            simModalUgsSelecionadas.clear();
          }
        } else if (alvo.dataset.ugNum) {
          const num = Number(alvo.dataset.ugNum);
          if (alvo.checked) simModalUgsSelecionadas.add(num);
          else simModalUgsSelecionadas.delete(num);
        }
        renderMultiselectUg();
        atualizarPreviewModalStress();
      });
    }
    el('modal-sim-manut').addEventListener('click', ev => {
      if (ev.target === el('modal-sim-manut')) {
        fecharModalStress();
        return;
      }
      if (!ev.target.closest('.cselect')) {
        fecharMenusCselect();
      }
    });
    const modalBodyEl = el('modal-sim-manut').querySelector('.modal-body');
    if (modalBodyEl) {
      modalBodyEl.addEventListener('scroll', () => {
        const aberto = document.querySelector('#modal-sim-manut .cselect.open');
        if (aberto) posicionarMenuCselect(aberto);
      });
    }
    window.addEventListener('resize', () => {
      const aberto = document.querySelector('#modal-sim-manut .cselect.open');
      if (aberto) posicionarMenuCselect(aberto);
    });
    document.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return;
      const aberto = document.querySelector('#modal-sim-manut .cselect.open');
      if (aberto) {
        fecharMenusCselect();
      } else if (!el('modal-sim-manut').hidden) {
        fecharModalStress();
      }
    });
  }

  function sincronizarHorasPorDias(dias) {
    if (!dias || dias < 1) return;
    const taxa = el('sim-manut-retorno').value === 'sim' ? 12 : 24;
    const brutoAnt = Number(el('sim-manut-bruto').value) || 0;
    const novoBruto = Number((dias * taxa).toFixed(1));
    el('sim-manut-bruto').value = String(novoBruto);
    if (el('sim-manut-expurgada').checked) {
      const expAnt = Number(el('sim-manut-expurgo-h').value) || 0;
      if (Math.abs(expAnt - brutoAnt) < 0.15 || expAnt > novoBruto) {
        el('sim-manut-expurgo-h').value = String(novoBruto);
      }
    }
  }
  if (el('sim-manut-inicio')) {
    el('sim-manut-inicio').onchange = () => {
      const ini = el('sim-manut-inicio').value;
      const fim = el('sim-manut-fim').value;
      if (ini && (!fim || fim < ini)) {
        const d = Math.max(1, parseInt(el('sim-manut-dias').value, 10) || 1);
        el('sim-manut-fim').value = somarDiasIso(ini, d - 1);
      }
      const dias = diffDiasInclusivo(el('sim-manut-inicio').value, el('sim-manut-fim').value);
      if (dias && dias >= 1) {
        el('sim-manut-dias').value = String(dias);
        sincronizarHorasPorDias(dias);
      }
      atualizarPreviewModalStress();
    };
  }
  if (el('sim-manut-fim')) {
    el('sim-manut-fim').onchange = () => {
      const dias = diffDiasInclusivo(el('sim-manut-inicio').value, el('sim-manut-fim').value);
      if (dias && dias >= 1) {
        el('sim-manut-dias').value = String(dias);
        sincronizarHorasPorDias(dias);
      }
      atualizarPreviewModalStress();
    };
  }
  if (el('sim-manut-dias')) {
    el('sim-manut-dias').oninput = () => {
      const dias = parseInt(el('sim-manut-dias').value, 10);
      if (Number.isFinite(dias) && dias >= 1 && el('sim-manut-inicio').value) {
        el('sim-manut-fim').value = somarDiasIso(el('sim-manut-inicio').value, dias - 1);
        sincronizarHorasPorDias(dias);
      }
      atualizarPreviewModalStress();
    };
  }
  if (el('sim-manut-expurgada')) {
    el('sim-manut-expurgada').onchange = () => {
      const chk = el('sim-manut-expurgada').checked;
      el('sim-manut-expurgo-h').disabled = !chk;
      if (chk) {
        const atual = Number(el('sim-manut-expurgo-h').value) || 0;
        if (atual <= 0) el('sim-manut-expurgo-h').value = el('sim-manut-bruto').value || '0';
      } else {
        el('sim-manut-expurgo-h').value = '0';
      }
      atualizarPreviewModalStress();
    };
  }
  for (const id of ['sim-manut-bruto', 'sim-manut-expurgo-h']) {
    if (el(id)) el(id).addEventListener('input', atualizarPreviewModalStress);
  }
  if (el('form-sim-manut')) {
    el('form-sim-manut').onsubmit = ev => {
      ev.preventDefault();
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      const mesMin = M.moverMes(D.mes_base, 1);
      const mesMax = M.moverMes(D.mes_base, e.horizonte);
      const dadosModal = lerEventoModalStress();
      if (!dadosModal.ugs.length) {
        el('sim-manut-erro').textContent = 'Selecione ao menos uma UG para aplicar na simulação.';
        el('sim-manut-erro').hidden = false;
        return;
      }
      let rateio;
      try {
        rateio = M.ratearManutencaoSimulada(dadosModal, {
          aplicarExpurgos: e.aplicarExpurgos !== false,
          mesMin,
          mesMax,
        });
      } catch (erro) {
        el('sim-manut-erro').textContent = erro.message;
        el('sim-manut-erro').hidden = false;
        return;
      }
      if (!rateio.meses.length) return;

      const registro = {
        id: simModalEditId || `sim_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        ...dadosModal,
        horas_brutas: rateio.horas_brutas,
        expurgo_horas: rateio.expurgo_horas,
      };
      if (simModalEditId) {
        const idx = e.simuladas.findIndex(x => x.id === simModalEditId);
        if (idx >= 0) e.simuladas[idx] = registro;
        else e.simuladas.push(registro);
      } else {
        e.simuladas.push(registro);
      }

      reconstruirEdicoesComSimuladas(u, e);
      el('mes-edicao').value = rateio.meses[0].mes;
      if (el('estado-efetivar')) {
        el('estado-efetivar').textContent = '';
        el('estado-efetivar').className = 'status-msg';
      }
      guardar();
      renderTabelaSimuladas();
      renderEditor();
      renderSimulacao();
      fecharModalStress();
    };
  }

  if (el('tabela-sim-manutencoes')) {
    el('tabela-sim-manutencoes').onclick = ev => {
      const btnEdit = ev.target.closest('button[data-sim-edit]');
      const btnDel = ev.target.closest('button[data-sim-del]');
      if (!btnEdit && !btnDel) return;
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      if (btnEdit) {
        const alvo = (e.simuladas || []).find(x => x.id === btnEdit.dataset.simEdit);
        if (alvo) abrirModalStress(alvo);
      } else if (btnDel) {
        e.simuladas = (e.simuladas || []).filter(x => x.id !== btnDel.dataset.simDel);
        reconstruirEdicoesComSimuladas(u, e);
        guardar();
        renderTabelaSimuladas();
        renderEditor();
        renderSimulacao();
      }
    };
  }
  if (el('btn-sim-limpar-eventos')) {
    el('btn-sim-limpar-eventos').onclick = () => {
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      e.simuladas = [];
      reconstruirEdicoesComSimuladas(u, e);
      guardar();
      renderTabelaSimuladas();
      renderEditor();
      renderSimulacao();
    };
  }

  // ===== MODAL DE EFETIVAÇÃO NO PLANO REAL =====
  let efetivarAlvoCustom = null; // null = cenário ativo; ou { cod_ceg, usina, eventos, origemSalvo }

  function fecharModalEfetivar() {
    efetivarAlvoCustom = null;
    const m = el('modal-efetivar-sim');
    if (!m) return;
    m.hidden = true;
    document.body.style.overflow = '';
  }
  function abrirModalEfetivar(alvoCustom = null) {
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    const lista = alvoCustom ? (alvoCustom.eventos || []) : (e.simuladas || []);
    if (!lista.length) return;
    efetivarAlvoCustom = alvoCustom;

    const statusEl = el('estado-efetivar');
    if (!temServidorDisponivel()) {
      efetivarAlvoCustom = null;
      if (statusEl) {
        statusEl.className = 'status-msg warn';
        statusEl.innerHTML =
          'Para efetivar o cenário no banco real de Paradas Programadas, inicie o servidor local com <code>python scripts/executar.py --painel</code>.';
      }
      return;
    }

    const totalUgs = D.horas.filter(r => r.cod_ceg === u.cod_ceg && mes(r.data) === D.mes_base).length;
    const totalRegistros = lista.reduce((s, ev) => s + (ev.ugs?.length || 0), 0);
    const box = el('efetivar-resumo-lista');
    if (box) {
      const subTitulo = alvoCustom?.nome ? ` · Cenário salvo "${alvoCustom.nome}"` : '';
      box.innerHTML =
        `<div class="efetivar-item-meta"><strong>${esc(u.usina)}</strong>${esc(subTitulo)} · ${lista.length} ${lista.length === 1 ? 'evento' : 'eventos'} (${totalRegistros} registro${totalRegistros === 1 ? '' : 's'} por UG a gravar no banco real)</div>` +
        lista
          .map(ev => {
            const infoCls = infoClassificadorModal(ev.classificador);
            const corTipo = TIPO_COR[ev.tipo_manut] || '#475569';
            return `<div class="efetivar-item">
              <div class="efetivar-item-top">
                <span>
                  <strong>${esc(formatarUgsResumo(ev.ugs, totalUgs))}</strong>
                  <span class="badge info cselect-pill-sm" style="background:${corTipo}20;color:${corTipo}">${esc(ev.tipo_manut)}</span>
                  ${badgeClassificador(ev.classificador, infoCls?.grupo_ons)}
                </span>
                <span>${dataDia(ev.data_inicio)} a ${dataDia(ev.data_fim)} · <strong>${numero(ev.horas_brutas, 1)} h</strong></span>
              </div>
              ${ev.descricao ? `<div class="efetivar-item-meta">${esc(ev.descricao)}</div>` : ''}
            </div>`;
          })
          .join('');
    }
    if (el('efetivar-erro')) el('efetivar-erro').hidden = true;
    if (el('btn-confirmar-efetivar')) {
      el('btn-confirmar-efetivar').disabled = false;
      el('btn-confirmar-efetivar').textContent = '✓ Confirmar e Tornar Real';
    }
    el('modal-efetivar-sim').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  if (el('btn-sim-efetivar-real')) {
    el('btn-sim-efetivar-real').onclick = () => abrirModalEfetivar(null);
  }
  if (el('btn-fechar-modal-efetivar')) {
    el('btn-fechar-modal-efetivar').onclick = fecharModalEfetivar;
  }
  if (el('btn-cancelar-efetivar')) {
    el('btn-cancelar-efetivar').onclick = fecharModalEfetivar;
  }
  if (el('modal-efetivar-sim')) {
    el('modal-efetivar-sim').addEventListener('click', ev => {
      if (ev.target === el('modal-efetivar-sim')) fecharModalEfetivar();
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !el('modal-efetivar-sim').hidden) fecharModalEfetivar();
    });
  }
  if (el('btn-confirmar-efetivar')) {
    el('btn-confirmar-efetivar').onclick = async () => {
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      const lista = efetivarAlvoCustom ? (efetivarAlvoCustom.eventos || []) : (e.simuladas || []);
      const cegAlvo = efetivarAlvoCustom?.cod_ceg || u.cod_ceg;
      const eraAtivo = !efetivarAlvoCustom;
      if (!lista.length) return;
      const btn = el('btn-confirmar-efetivar');
      const err = el('efetivar-erro');
      btn.disabled = true;
      btn.textContent = 'Salvando no banco real…';
      if (err) err.hidden = true;
      try {
        const resp = await fetch(apiUrl('/api/manutencoes/efetivar'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cod_ceg: cegAlvo, eventos: lista }),
        });
        const corpo = await resp.json();
        if (!resp.ok) throw new Error(corpo.erro || 'Não foi possível efetivar as manutenções.');

        if (corpo.dados) {
          D = corpo.dados;
        }
        if (eraAtivo) {
          e.simuladas = [];
          e.baseModo = 'plano';
        }
        reconstruirEdicoesComSimuladas(u, e);
        guardar();
        fecharModalEfetivar();

        popularFiltros();
        configurarSimulacao();
        const statusEl = el('estado-efetivar');
        if (statusEl) {
          statusEl.className = 'status-msg ok';
          statusEl.innerHTML =
            `✓ <strong>${corpo.adicionadas} ${corpo.adicionadas === 1 ? 'registro efetivado' : 'registros efetivados'}</strong> no banco real de Paradas Programadas. ` +
            `<button type="button" class="link-inline" id="btn-ver-efetivadas-manut">Abrir Paradas Programadas</button>`;
          if (el('btn-ver-efetivadas-manut')) {
            el('btn-ver-efetivadas-manut').onclick = () => irPara('manutencoes');
          }
        }
      } catch (erro) {
        if (err) {
          err.textContent = erro.message;
          err.hidden = false;
        }
        btn.disabled = false;
        btn.textContent = '✓ Confirmar e Tornar Real';
      }
    };
  }

  // ===== BIBLIOTECA DE CENÁRIOS SIMULADOS SALVOS (USO FUTURO) =====
  const CHAVE_SALVOS_LOCAL = 'ctg-cenarios-salvos-v1';
  let cacheCenariosSalvos = [];

  function lerSalvosLocal(codCeg = null) {
    try {
      const lista = JSON.parse(localStorage.getItem(CHAVE_SALVOS_LOCAL) || '[]');
      if (!Array.isArray(lista)) return [];
      const filt = codCeg ? lista.filter(c => c && c.cod_ceg === codCeg) : lista;
      return filt.sort((a, b) => String(b.atualizado_em || b.criado_em || '').localeCompare(String(a.atualizado_em || a.criado_em || '')));
    } catch (_) {
      return [];
    }
  }
  function gravarSalvosLocal(lista) {
    try { localStorage.setItem(CHAVE_SALVOS_LOCAL, JSON.stringify(lista)); } catch (_) {}
  }
  async function carregarCenariosSalvos(codCeg) {
    if (temServidorDisponivel()) {
      try {
        const resp = await fetch(apiUrl(`/api/cenarios-salvos?cod_ceg=${encodeURIComponent(codCeg)}`));
        if (resp.ok) {
          const corpo = await resp.json();
          cacheCenariosSalvos = Array.isArray(corpo.cenarios) ? corpo.cenarios : [];
          return cacheCenariosSalvos;
        }
      } catch (_) {}
    }
    cacheCenariosSalvos = lerSalvosLocal(codCeg);
    return cacheCenariosSalvos;
  }
  async function atualizarBadgeCenariosSalvos() {
    const u = usinaAtual();
    const badge = el('badge-qtd-salvos');
    if (!u || !badge) return;
    const lista = await carregarCenariosSalvos(u.cod_ceg);
    badge.textContent = String(lista.length);
    badge.className = `badge ${lista.length ? 'info' : 'neutral'} cselect-pill-sm`;
  }
  function formatarDataHoraBr(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fecharModalSalvarCenario() {
    const m = el('modal-salvar-cenario');
    if (!m) return;
    m.hidden = true;
    document.body.style.overflow = '';
  }
  function abrirModalSalvarCenario() {
    const u = usinaAtual();
    const m = el('modal-salvar-cenario');
    if (!u || !m) return;
    const e = estadoSim(u.cod_ceg);
    const qtdSim = (e.simuladas || []).length;
    el('salvar-cen-nome').value = '';
    el('salvar-cen-desc').value = '';
    if (el('salvar-cen-erro')) el('salvar-cen-erro').hidden = true;
    if (el('salvar-cen-resumo')) {
      el('salvar-cen-resumo').innerHTML = `
        <div class="modal-preview-meta">
          <strong>${esc(u.usina)}</strong> · Horizonte: <strong>${e.horizonte} meses</strong> ·
          ID Ref.: <strong>${pct(e.idRef)}</strong> ·
          Expurgos ONS: <strong>${e.aplicarExpurgos !== false ? 'Aplicados' : 'Desativados'}</strong> ·
          Eventos simulados: <strong>${qtdSim}</strong>
        </div>`;
    }
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    el('salvar-cen-nome')?.focus();
  }

  function fecharModalCenariosSalvos() {
    const m = el('modal-cenarios-salvos');
    if (!m) return;
    m.hidden = true;
    document.body.style.overflow = '';
  }
  function renderListaCenariosSalvos(lista) {
    const box = el('lista-cenarios-salvos');
    if (!box) return;
    if (!lista.length) {
      box.innerHTML =
        '<div class="empty-state" style="padding:24px">Nenhum cenário simulado salvo para esta usina ainda. Clique em <strong>Salvar Cenário</strong> para guardar a configuração atual para uso futuro.</div>';
      return;
    }
    box.innerHTML = lista
      .map(c => {
        const qtdEv = Array.isArray(c.simuladas) ? c.simuladas.length : 0;
        const qtdRegs = (c.simuladas || []).reduce((s, ev) => s + (ev.ugs?.length || 0), 0);
        return `<div class="salvo-card">
          <div class="salvo-card-head">
            <span class="salvo-card-title">${esc(c.nome)}</span>
            <span class="salvo-card-date">Salvo em ${esc(formatarDataHoraBr(c.atualizado_em || c.criado_em))}</span>
          </div>
          ${c.descricao ? `<div class="salvo-card-desc">${esc(c.descricao)}</div>` : ''}
          <div class="salvo-card-tags">
            <span class="badge neutral cselect-pill-sm">Horizonte: ${c.horizonte || 24}m</span>
            <span class="badge neutral cselect-pill-sm">ID Ref.: ${pct(c.idRef)}</span>
            <span class="badge ${c.aplicarExpurgos !== false ? '' : 'warn'} cselect-pill-sm">Expurgos ONS: ${c.aplicarExpurgos !== false ? 'Sim' : 'Não'}</span>
            <span class="badge info cselect-pill-sm">${qtdEv} ${qtdEv === 1 ? 'evento simulado' : 'eventos simulados'}${qtdRegs ? ` (${qtdRegs} UGs)` : ''}</span>
          </div>
          <div class="salvo-card-actions">
            <button type="button" class="btn secondary btn-xs" data-cen-load="${esc(c.id)}">Carregar no Simulador</button>
            ${qtdEv > 0 ? `<button type="button" class="btn primary btn-xs" data-cen-real="${esc(c.id)}">✓ Efetivar no Plano Real</button>` : ''}
            <button type="button" class="btn btn-xs danger-outline" data-cen-del="${esc(c.id)}">Excluir</button>
          </div>
        </div>`;
      })
      .join('');
  }
  async function abrirModalCenariosSalvos() {
    const u = usinaAtual();
    const m = el('modal-cenarios-salvos');
    if (!u || !m) return;
    if (el('modal-cenarios-salvos-titulo')) {
      el('modal-cenarios-salvos-titulo').textContent = `Cenários Simulados Salvos · ${u.usina}`;
    }
    if (el('salvos-erro')) el('salvos-erro').hidden = true;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    const lista = await carregarCenariosSalvos(u.cod_ceg);
    renderListaCenariosSalvos(lista);
  }

  if (el('btn-sim-salvar-cenario')) el('btn-sim-salvar-cenario').onclick = abrirModalSalvarCenario;
  if (el('btn-fechar-modal-salvar')) el('btn-fechar-modal-salvar').onclick = fecharModalSalvarCenario;
  if (el('btn-cancelar-salvar-cen')) el('btn-cancelar-salvar-cen').onclick = fecharModalSalvarCenario;
  if (el('modal-salvar-cenario')) {
    el('modal-salvar-cenario').addEventListener('click', ev => {
      if (ev.target === el('modal-salvar-cenario')) fecharModalSalvarCenario();
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !el('modal-salvar-cenario').hidden) fecharModalSalvarCenario();
    });
  }
  if (el('form-salvar-cenario')) {
    el('form-salvar-cenario').onsubmit = async ev => {
      ev.preventDefault();
      const u = usinaAtual();
      if (!u) return;
      const e = estadoSim(u.cod_ceg);
      const nome = (el('salvar-cen-nome').value || '').trim();
      const descricao = (el('salvar-cen-desc').value || '').trim();
      const err = el('salvar-cen-erro');
      if (!nome) {
        err.textContent = 'Informe um nome para identificar o cenário salvo.';
        err.hidden = false;
        return;
      }
      const btn = el('btn-confirmar-salvar-cen');
      btn.disabled = true;
      btn.textContent = 'Salvando…';
      err.hidden = true;
      const payload = {
        nome,
        descricao,
        cod_ceg: u.cod_ceg,
        usina: u.usina,
        horizonte: e.horizonte,
        idRef: e.idRef,
        aplicarExpurgos: e.aplicarExpurgos !== false,
        baseModo: e.baseModo || 'plano',
        simuladas: JSON.parse(JSON.stringify(e.simuladas || [])),
        edicoes: JSON.parse(JSON.stringify(e.edicoes || {})),
      };
      try {
        if (temServidorDisponivel()) {
          const resp = await fetch(apiUrl('/api/cenarios-salvos'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const corpo = await resp.json();
          if (!resp.ok) throw new Error(corpo.erro || 'Não foi possível salvar o cenário.');
          cacheCenariosSalvos = corpo.cenarios || [];
        } else {
          const agora = new Date().toISOString();
          const todos = lerSalvosLocal();
          const novo = { ...payload, id: `cen_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, criado_em: agora, atualizado_em: agora };
          todos.unshift(novo);
          gravarSalvosLocal(todos);
          cacheCenariosSalvos = lerSalvosLocal(u.cod_ceg);
        }
        fecharModalSalvarCenario();
        atualizarBadgeCenariosSalvos();
        const statusEl = el('estado-efetivar');
        if (statusEl) {
          statusEl.className = 'status-msg ok';
          statusEl.innerHTML =
            `✓ Cenário <strong>${esc(nome)}</strong> salvo para uso futuro (sem alterar o plano real). ` +
            `<button type="button" class="link-inline" id="btn-abrir-salvos-link">Ver Cenários Salvos</button>`;
          if (el('btn-abrir-salvos-link')) el('btn-abrir-salvos-link').onclick = abrirModalCenariosSalvos;
        }
      } catch (erro) {
        err.textContent = erro.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Salvar Cenário';
      }
    };
  }

  if (el('btn-sim-ver-salvos')) el('btn-sim-ver-salvos').onclick = abrirModalCenariosSalvos;
  if (el('btn-fechar-modal-salvos')) el('btn-fechar-modal-salvos').onclick = fecharModalCenariosSalvos;
  if (el('btn-fechar-rodape-salvos')) el('btn-fechar-rodape-salvos').onclick = fecharModalCenariosSalvos;
  if (el('modal-cenarios-salvos')) {
    el('modal-cenarios-salvos').addEventListener('click', ev => {
      if (ev.target === el('modal-cenarios-salvos')) fecharModalCenariosSalvos();
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && !el('modal-cenarios-salvos').hidden) fecharModalCenariosSalvos();
    });
  }
  if (el('lista-cenarios-salvos')) {
    el('lista-cenarios-salvos').onclick = async ev => {
      const btnLoad = ev.target.closest('button[data-cen-load]');
      const btnReal = ev.target.closest('button[data-cen-real]');
      const btnDel = ev.target.closest('button[data-cen-del]');
      if (!btnLoad && !btnReal && !btnDel) return;
      const u = usinaAtual();
      if (!u) return;

      if (btnLoad) {
        const alvo = cacheCenariosSalvos.find(c => c.id === btnLoad.dataset.cenLoad);
        if (!alvo) return;
        const e = estadoSim(u.cod_ceg);
        e.horizonte = Number(alvo.horizonte) || 24;
        e.idRef = Number.isFinite(alvo.idRef) ? alvo.idRef : u.id_referencia;
        e.aplicarExpurgos = alvo.aplicarExpurgos !== false;
        e.baseModo = alvo.baseModo === 'zero' ? 'zero' : 'plano';
        e.simuladas = JSON.parse(JSON.stringify(alvo.simuladas || []));
        if (alvo.edicoes && typeof alvo.edicoes === 'object') {
          e.edicoes = JSON.parse(JSON.stringify(alvo.edicoes));
        } else {
          reconstruirEdicoesComSimuladas(u, e);
        }
        guardar();
        fecharModalCenariosSalvos();
        configurarSimulacao();
        const statusEl = el('estado-efetivar');
        if (statusEl) {
          statusEl.className = 'status-msg ok';
          statusEl.innerHTML = `Cenário <strong>${esc(alvo.nome)}</strong> carregado no simulador (somente simulação).`;
        }
      } else if (btnReal) {
        const alvo = cacheCenariosSalvos.find(c => c.id === btnReal.dataset.cenReal);
        if (!alvo || !Array.isArray(alvo.simuladas) || !alvo.simuladas.length) return;
        fecharModalCenariosSalvos();
        abrirModalEfetivar({
          cod_ceg: alvo.cod_ceg,
          usina: alvo.usina,
          nome: alvo.nome,
          eventos: alvo.simuladas,
        });
      } else if (btnDel) {
        const cid = btnDel.dataset.cenDel;
        const err = el('salvos-erro');
        if (err) err.hidden = true;
        try {
          if (temServidorDisponivel()) {
            const resp = await fetch(apiUrl('/api/cenarios-salvos/excluir'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: cid, cod_ceg: u.cod_ceg }),
            });
            const corpo = await resp.json();
            if (!resp.ok) throw new Error(corpo.erro || 'Não foi possível excluir o cenário.');
            cacheCenariosSalvos = corpo.cenarios || [];
          } else {
            const todos = lerSalvosLocal().filter(c => c.id !== cid);
            gravarSalvosLocal(todos);
            cacheCenariosSalvos = lerSalvosLocal(u.cod_ceg);
          }
          renderListaCenariosSalvos(cacheCenariosSalvos);
          atualizarBadgeCenariosSalvos();
        } catch (erro) {
          if (err) {
            err.textContent = erro.message;
            err.hidden = false;
          }
        }
      }
    };
  }

  el('tabela-editor').oninput = ev => {
    const alvo = ev.target;
    if (!alvo.matches('input[data-ug]')) return;
    const u = usinaAtual();
    if (!u) return;
    const e = estadoSim(u.cod_ceg);
    const m = el('mes-edicao').value;
    const k = `${m}|${alvo.dataset.ug}`;
    if (!e.edicoes[k]) e.edicoes[k] = {};
    e.edicoes[k][alvo.dataset.campo] = alvo.value === '' ? 0 : Number(alvo.value);
    const saldo = M.horasMes(m) - M.CAMPOS.reduce((s, c) => s + (e.edicoes[k][c] || 0), 0);
    const sEl = el(`saldo-${alvo.dataset.ug}`);
    sEl.textContent = numero(saldo, 2);
    sEl.classList.toggle('saldo-invalido', saldo < 0);
    guardar();
    el('estado-salvar').textContent = '';
    renderSimulacao();
  };

  function exportarCenarioCsvOffline(usina, cenario) {
    const cab = ['mes_fim_historico', 'mes_referencia_contabil', 'teifa_pct', 'teip_pct', 'id_verificado_pct', 'id_referencia_pct', 'fid_bruto', 'fid_mra'];
    const linhas = [cab.join(';')];
    for (const r of cenario.resultados) {
      linhas.push([
        r.mes_fim_historico,
        r.mes_referencia_contabil,
        r.teifa === null ? '' : (r.teifa * 100).toFixed(6),
        r.teip === null ? '' : (r.teip * 100).toFixed(6),
        r.id_verificado === null ? '' : (r.id_verificado * 100).toFixed(6),
        r.id_referencia === null ? '' : (r.id_referencia * 100).toFixed(6),
        r.fid_bruto === null ? '' : r.fid_bruto.toFixed(6),
        r.fid_mra === null ? '' : r.fid_mra.toFixed(6),
      ].join(';'));
    }
    const nome = `cenario_${usina.usina.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${D.mes_base}.csv`;
    const blob = new Blob(['\ufeff' + linhas.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return nome;
  }

  el('salvar-cenario').onclick = async ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!ultimoCenario) return;
    const u = usinaAtual();
    if (!temServidorDisponivel()) {
      if (isNativeApp()) {
        const nome = exportarCenarioCsvOffline(u, ultimoCenario);
        el('estado-salvar').textContent = `Modo offline: cenário exportado em CSV (${nome}). Para gravar em Parquet/DuckDB, conecte o servidor em Admin.`;
      } else {
        el('estado-salvar').textContent = 'Para salvar em Parquet, execute: python scripts/executar.py --painel';
      }
      return;
    }
    const e = estadoSim(u.cod_ceg);
    const botao = el('salvar-cenario');
    botao.disabled = true;
    el('estado-salvar').textContent = 'Validando e gravando cenário no DuckDB…';
    try {
      const alteracoes = ultimoCenario.plano
        .filter(r => M.CAMPOS.some(c => r[c] !== 0))
        .map(r => ({ mes: r.mes, ug: r.ug, ...Object.fromEntries(M.CAMPOS.map(c => [c, r[c]])) }));
      const retorno = await apiJson('/api/cenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cod_ceg: u.cod_ceg, horizonte: e.horizonte, id_referencia: e.idRef, alteracoes }),
      });
      el('estado-salvar').innerHTML =
        'Cenário gravado em <code>resultados/cenarios/</code>. ' +
        retorno.arquivos
          .map((a, i) => `<a href="${apiUrl('/arquivos/' + encodeURIComponent(a))}" download>${i === 0 ? '⬇ Baixar horas por UG' : '⬇ Baixar índices projetados'}</a>`)
          .join('');
    } catch (erro) {
      el('estado-salvar').textContent = erro.message;
    } finally {
      botao.disabled = false;
    }
  };

  // Manutencoes filtros
  for (const id of ['manut-ano', 'manut-tipo', 'manut-classificador', 'manut-status']) {
    if (el(id)) el(id).onchange = () => { renderManutencoes(); atualizarUiMobile(); };
  }
  el('manut-busca').oninput = () => renderManutencoes();

  // Projecao ID Ref controles
  if (el('proj-mes-corte')) {
    el('proj-mes-corte').onchange = () => {
      sinOverrides = {};
      renderProjecao();
      atualizarUiMobile();
    };
  }
  for (const id of ['fator-teif', 'fator-teip']) {
    el(id).oninput = () => { renderProjecao(); atualizarUiMobile(); };
  }
  el('chk-excluir-pimental').onchange = () => {
    delete sinOverrides['TAX165'];
    renderProjecao();
    atualizarUiMobile();
  };
  el('chk-excluir-belomonte').onchange = () => {
    delete sinOverrides['SIN76'];
    renderProjecao();
    atualizarUiMobile();
  };
  el('chk-incluir-itaipu').onchange = () => {
    delete sinOverrides['SIN83-GERAL'];
    renderProjecao();
    atualizarUiMobile();
  };
  el('proj-reset').onclick = () => {
    if (el('proj-mes-corte')) {
      const padraoSin = (D.sin_meses && D.sin_meses[0]) || D.mes_base;
      el('proj-mes-corte').value = padraoSin;
    }
    el('fator-teif').value = '1.00';
    el('fator-teip').value = '1.00';
    el('chk-excluir-pimental').checked = false;
    el('chk-excluir-belomonte').checked = false;
    el('chk-incluir-itaipu').checked = true;
    sinOverrides = {};
    renderProjecao();
    atualizarUiMobile();
  };
  for (const id of ['sin-filtro-faixa', 'sin-filtro-status']) el(id).onchange = () => renderTabelaSinConfig();
  el('sin-busca').oninput = () => renderTabelaSinConfig();
  el('sin-reset-overrides').onclick = () => {
    sinOverrides = {};
    el('chk-excluir-pimental').checked = false;
    el('chk-excluir-belomonte').checked = false;
    el('chk-incluir-itaipu').checked = true;
    renderProjecao();
    atualizarUiMobile();
  };
  el('tabela-sin-config').onchange = ev => {
    const chk = ev.target.closest('input.sin-chk[data-sin-id]');
    if (!chk) return;
    const idSin = chk.dataset.sinId;
    const marcado = chk.checked;
    const orig = sinUsinasAtuais().find(u => u.id_sin === idSin);
    if (idSin === 'TAX165') el('chk-excluir-pimental').checked = !marcado;
    if (idSin === 'SIN76') el('chk-excluir-belomonte').checked = !marcado;
    if (idSin === 'SIN83-GERAL') el('chk-incluir-itaipu').checked = marcado;
    if (orig && marcado === Boolean(orig.valida_calculo)) {
      delete sinOverrides[idSin];
    } else {
      sinOverrides[idSin] = marcado;
    }
    renderProjecao();
    atualizarUiMobile();
  };

  // Admin eventos
  el('form-admin-login').onsubmit = async ev => {
    ev.preventDefault();
    el('admin-login-erro').hidden = true;
    try {
      const res = await apiJson('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: el('admin-senha').value }),
      });
      el('admin-senha').value = '';
      adminAutenticado = true;
      atualizarVisaoAdmin(res.job);
    } catch (erro) {
      el('admin-login-erro').textContent = erro.message;
      el('admin-login-erro').hidden = false;
    }
  };
  el('btn-admin-logout').onclick = async () => {
    await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
    adminAutenticado = false;
    el('usuarios-lista').replaceChildren();
    editarUsuario();
    atualizarVisaoAdmin(null);
  };
  if (el('sessao-painel')) document.querySelector('[data-atab="usuarios"]').hidden = false;
  for (const btn of document.querySelectorAll('.admin-tab')) {
    btn.onclick = () => {
      const alvo = btn.dataset.atab;
      for (const b of document.querySelectorAll('.admin-tab')) b.classList.toggle('ativa', b === btn);
      for (const p of document.querySelectorAll('.atab-pane')) p.hidden = p.id !== `atab-${alvo}`;
      if (alvo === 'usuarios') carregarUsuariosUI();
    };
  }
  el('usuario-novo').onclick = () => {
    editarUsuario();
    el('usuario-nome').focus();
  };
  el('form-usuario').onsubmit = async ev => {
    ev.preventDefault();
    const botao = el('usuario-salvar');
    const status = el('usuario-status');
    const criar = !el('usuario-login').readOnly;
    botao.disabled = true;
    status.textContent = 'Salvando…';
    try {
      await apiJson('/api/admin/usuarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          criar,
          usuario: el('usuario-login').value,
          nome: el('usuario-nome').value,
          senha: el('usuario-senha').value,
          ativo: el('usuario-ativo').checked,
        }),
      });
      editarUsuario();
      status.textContent = criar ? 'Conta criada.' : 'Alterações salvas.';
      await carregarUsuariosUI();
    } catch (erro) {
      status.textContent = erro.message;
    } finally {
      botao.disabled = false;
    }
  };
  el('btn-run-recalcular').onclick = () => dispararPipeline('recalcular');
  el('btn-run-atualizar').onclick = () => dispararPipeline('atualizar_ons');
  el('btn-run-baixar').onclick = () => dispararPipeline('somente_baixar');
  el('btn-reload-dados').onclick = () => recarregarDadosInterface();

  el('btn-salvar-cfg').onclick = async () => {
    el('cfg-status').textContent = 'Salvando configuração…';
    try {
      await apiJson('/api/admin/config-fontes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origem_manutencoes: el('cfg-origem').value,
          excel_aba: el('cfg-excel-aba').value,
          excel_caminho: el('cfg-excel-caminho').value,
          database: {
            tipo: el('cfg-db-tipo').value,
            host: el('cfg-db-host').value,
            porta: Number(el('cfg-db-porta').value) || 5432,
            banco: el('cfg-db-banco').value,
            schema: el('cfg-db-schema').value,
            tabela: el('cfg-db-tabela').value,
            usuario: el('cfg-db-usuario').value,
            senha_env: el('cfg-db-senha-env').value,
            caminho_arquivo: el('cfg-db-arquivo').value,
          },
        }),
      });
      el('cfg-status').textContent = 'Configuração salva em dados/config_fontes.json.';
    } catch (erro) {
      el('cfg-status').textContent = `Erro: ${erro.message}`;
    }
  };
  el('btn-testar-db').onclick = async () => {
    el('cfg-status').textContent = 'Testando conexão…';
    try {
      const res = await apiJson('/api/admin/testar-conexao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          database: {
            tipo: el('cfg-db-tipo').value,
            host: el('cfg-db-host').value,
            porta: Number(el('cfg-db-porta').value) || 5432,
            banco: el('cfg-db-banco').value,
            usuario: el('cfg-db-usuario').value,
            senha_env: el('cfg-db-senha-env').value,
            caminho_arquivo: el('cfg-db-arquivo').value,
          },
        }),
      });
      el('cfg-status').textContent = res.mensagem;
    } catch (erro) {
      el('cfg-status').textContent = `Falha na conexão: ${erro.message}`;
    }
  };
  el('btn-upload-excel').onclick = async () => {
    const file = el('upload-excel-input').files?.[0];
    if (!file) { el('upload-status').textContent = 'Selecione um arquivo .xlsm ou .xlsx.'; return; }
    el('upload-status').textContent = 'Enviando e validando planilha…';
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const res = await apiJson('/api/admin/upload-manutencoes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome: file.name, conteudo_base64: btoa(bin) }),
      });
      el('upload-status').textContent = `OK! ${res.eventos_lidos} eventos lidos (${res.eventos_ativos_ons} ativos ONS). Iniciando recálculo…`;
      await dispararPipeline('recalcular');
    } catch (erro) {
      el('upload-status').textContent = `Erro: ${erro.message}`;
    }
  };

  el('btn-refresh-parquets').onclick = () => carregarParquetsUI();
  el('lista-parquets').onclick = ev => {
    const b = ev.target.closest('button[data-pq]');
    if (b) abrirPreviewParquet(b.dataset.pq, 0);
  };
  let pqTimer = null;
  el('pq-filtro').oninput = () => {
    if (!pqAtual) return;
    clearTimeout(pqTimer);
    pqTimer = setTimeout(() => abrirPreviewParquet(pqAtual, 0), 250);
  };
  el('pq-prev').onclick = () => pqAtual && abrirPreviewParquet(pqAtual, Math.max(0, pqOffset - 50));
  el('pq-next').onclick = () => pqAtual && abrirPreviewParquet(pqAtual, pqOffset + 50);

  el('sql-exemplos').onchange = () => {
    if (el('sql-exemplos').value) {
      el('sql-editor').value = el('sql-exemplos').value;
      executarSqlUI();
    }
  };
  el('btn-run-sql').onclick = () => executarSqlUI();
  el('btn-export-sql-csv').onclick = async () => {
    try {
      const res = await fetch('/api/admin/sql/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: el('sql-editor').value }),
      });
      if (!res.ok) throw new Error((await res.json()).erro || 'Falha ao exportar');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'consulta_duckdb.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (erro) {
      el('sql-erro').textContent = erro.message;
      el('sql-erro').hidden = false;
    }
  };

  el('form-alterar-senha').onsubmit = async ev => {
    ev.preventDefault();
    if (el('sec-nova').value !== el('sec-conf').value) {
      el('sec-status').textContent = 'A confirmação não confere com a nova senha.';
      return;
    }
    try {
      const res = await apiJson('/api/admin/alterar-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha_atual: el('sec-atual').value, nova_senha: el('sec-nova').value }),
      });
      el('sec-status').textContent = res.mensagem;
      el('form-alterar-senha').reset();
    } catch (erro) {
      el('sec-status').textContent = `Erro: ${erro.message}`;
    }
  };

  // Inicializacao
  popularFiltrosGlobais();
  atualizarFiltrosSidebar('atual');
  renderAtual();
  atualizarUiMobile();
})();
