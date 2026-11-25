"""Ingestao de paradas programadas, classificadores ONS (RO-AO.BR.04 Rev. 47) e regras de expurgo."""
from collections import defaultdict
from datetime import date, datetime, timedelta
import json
from pathlib import Path
import re

import openpyxl

from .caminhos import ARQUIVO_MANUTENCOES_PADRAO, CONFIG_FONTES


# Mapeamento oficial de siglas da planilha plurianual para o cadastro CTG Brasil / ONS.
# Tupla: (cod_ceg, nome_usina, polo_padrao, no_escopo_ons, qtd_ugs_escopo)
MAPA_UHE_CTG = {
    'CN1': ('UHE.PH.SP.000647-5.01', 'Canoas I', 'Polo Chavantes', True, 3),
    'CN2': ('UHE.PH.SP.027092-0.01', 'Canoas II', 'Polo Chavantes', True, 3),
    'CPV': ('UHE.PH.SP.000657-2.01', 'Capivara', 'Polo Capivara', True, 4),
    'CHV': ('UHE.PH.SP.000764-1.01', 'Chavantes', 'Polo Chavantes', True, 4),
    'GAR': ('UHE.PH.SC.030415-8.01', 'Garibaldi', 'Polo Capivara', True, 3),
    'ILS': ('UHE.PH.SP.001120-7.01', 'Ilha Solteira', 'Polo Ilha Solteira', True, 20),
    'JUP': ('UHE.PH.SP.001282-3.01', 'Jupia', 'Polo Jupiá', True, 14),
    'JUR': ('UHE.PH.SP.001285-8.01', 'Jurumirim', 'Polo Chavantes', True, 2),
    'ROS': ('UHE.PH.SP.002555-0.01', 'Rosana', 'Polo Capivara', True, 4),
    'STO': ('UHE.PH.GO.028758-0.01', 'Salto', 'Polo Jupiá', True, 2),
    'SAG': ('UHE.PH.SP.002648-4.01', 'Salto Grande SP', 'Polo Chavantes', True, 4),
    'TAQ': ('UHE.PH.SP.002821-5.01', 'Taquarucu', 'Polo Capivara', True, 5),
    'PLM': (None, 'PCH Palmeiras', 'Polo Chavantes', False, 0),
    'RET': (None, 'PCH Retiro', 'Polo Chavantes', False, 0),
}

MAPA_POLO_NOME = {
    'CHV': 'Polo Chavantes',
    'CPV': 'Polo Capivara',
    'JUP': 'Polo Jupiá',
    'ILS': 'Polo Ilha Solteira',
}

# Catalogo oficial dos 13 classificadores de origem da rotina ONS RO-AO.BR.04 Rev. 47
# (vigencia 25/06/2026, item 7.1.3 e Anexo 2) e REN ANEEL 1.033/2022.
CLASSIFICADORES_ONS = [
    # --- Item 7.1.3.1: Responsabilidade do empreendimento CONSIDERADAS em TEIFa / TEIP ---
    {
        'codigo': 'GUM',
        'nome': 'Responsabilidade da Usina / Gerador',
        'grupo_ons': '7.1.3.1',
        'grupo_label': '7.1.3.1 · Considerada (impacta TEIFa/TEIP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HDP / HDF',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': (
            'Indisponibilidades de responsabilidade do empreendimento de geração: turbina, gerador, '
            'transformador elevador, tomada d\'água, serviços auxiliares, proteção/controle, '
            'desligamento para intervenção em outra UG (CSEG), piracema/erosão e testes de interesse do agente.'
        ),
        'regra_excedente': 'Recebe todos os excedentes de franquia de GIM, GMT e GIC.',
    },
    {
        'codigo': 'GAC',
        'nome': 'Ativos de Conexão do Gerador',
        'grupo_ons': '7.1.3.1',
        'grupo_label': '7.1.3.1 · Considerada (impacta TEIFa/TEIP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HDP / HDF',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': 'Restrição elétrica imposta por ativos de conexão de propriedade do empreendimento de geração.',
        'regra_excedente': 'Impacta integralmente TEIFa e TEIP.',
    },
    {
        'codigo': 'GRH',
        'nome': 'Perda de Carga + Restrição Hídrica',
        'grupo_ons': '7.1.3.1',
        'grupo_label': '7.1.3.1 · Considerada (impacta TEIFa/TEIP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HEDP / HEDF',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': (
            'UG em operação com restrições decorrentes de perda de carga hidráulica concomitantemente '
            'com restrição hídrica por queda útil (Despacho ANEEL nº 3.630/2019).'
        ),
        'regra_excedente': 'Impacta TEIFa/TEIP como restrição parcial equivalente.',
    },
    {
        'codigo': 'GCB',
        'nome': 'Falta de Combustível (Taxas + Penalidade)',
        'grupo_ons': '7.1.3.1',
        'grupo_label': '7.1.3.1 · Considerada (impacta TEIFa/TEIP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HDP / HDF',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': False,
        'descricao': 'Restrições em termelétricas associadas ao fornecimento de combustível consideradas nas taxas e na penalidade.',
        'regra_excedente': 'Aplicável apenas a UTEs.',
    },
    {
        'codigo': 'GCC',
        'nome': 'Falta de Combustível (Taxas, s/ Penalidade)',
        'grupo_ons': '7.1.3.1',
        'grupo_label': '7.1.3.1 · Considerada (impacta TEIFa/TEIP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HDP / HDF',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': False,
        'descricao': 'Restrições em termelétricas por combustível consideradas nas taxas, mas desconsideradas na penalidade por falta de combustível.',
        'regra_excedente': 'Aplicável apenas a UTEs.',
    },
    # --- Item 7.1.3.2: Responsabilidade do empreendimento DESCONSIDERADAS (Expurgo -> HRD, exceto GCI -> HDCE) ---
    {
        'codigo': 'GIS',
        'nome': 'Determinação ONS/ANEEL, Aproveitamento ou Prev. Mexilhão',
        'grupo_ons': '7.1.3.2',
        'grupo_label': '7.1.3.2 · Expurgada (entra em HRD)',
        'impacta_taxas': False,
        'expurgo_integral': True,
        'destino_parametro': 'HRD',
        'destino_expurgo': 'HRD',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': (
            'Indisponibilidade de responsabilidade do gerador desconsiderada nas taxas: instalação de SMF/sistemas '
            'por determinação do ONS/CCEE/ANEEL, ensaios de autorrestabelecimento (Black Start), desligamentos em '
            'aproveitamento a intervenções na transmissão/distribuição e medidas preventivas contra mexilhão dourado '
            'e plantas aquáticas (antiga sigla GMP).'
        ),
        'regra_excedente': 'Expurgo integral (100%) quando enquadrada e aprovada pelo ONS; entra em HRD.',
    },
    {
        'codigo': 'GIM',
        'nome': 'Modernização, Reforma ou Melhoria (SIN)',
        'grupo_ons': '7.1.3.2',
        'grupo_label': '7.1.3.2 · Expurgada até franquia (HRD -> GUM)',
        'impacta_taxas': False,
        'expurgo_integral': False,
        'destino_parametro': 'HRD (exced. HDP)',
        'destino_expurgo': 'HRD',
        'franquia_tipo': 'POR_UG',
        'franquia_horas': 8760.0,  # 12 meses (8.760 h ano comum / 8.784 h bissexto)
        'aplica_uhe': True,
        'descricao': (
            'Intervenções de modernização, reforma ou melhoria com ganhos operativos ao SIN, após 120 meses '
            '(10 anos) de operação comercial. Consumo cronológico contínuo (item 5.2.4, sem fracionamento interno).'
        ),
        'regra_excedente': 'Franquia de 12 meses (~8.760 h) por UG durante a outorga/renovação; excedente vira GUM (HDP).',
    },
    {
        'codigo': 'GMT',
        'nome': 'Limpeza Mexilhão Dourado / Plantas Aquáticas',
        'grupo_ons': '7.1.3.2',
        'grupo_label': '7.1.3.2 · Expurgada até franquia (HRD -> GUM)',
        'impacta_taxas': False,
        'expurgo_integral': False,
        'destino_parametro': 'HRD (exced. HDP)',
        'destino_expurgo': 'HRD',
        'franquia_tipo': 'POR_USINA_UG',
        'franquia_horas': 360.0,  # 360 h x N_UGs acumulado por usina
        'aplica_uhe': True,
        'descricao': (
            'Indisponibilidades em UHEs para limpeza e remoção de mexilhão dourado e/ou plantas aquáticas '
            '(sem eliminação definitiva do problema).'
        ),
        'regra_excedente': 'Franquia acumulada na usina equivalente a 360 h por UG (360 × N_UGs); excedente vira GUM (HDP).',
    },
    {
        'codigo': 'GIC',
        'nome': 'Início de Operação Comercial (UG Nova)',
        'grupo_ons': '7.1.3.2',
        'grupo_label': '7.1.3.2 · Expurgada até franquia (HRD -> GUM)',
        'impacta_taxas': False,
        'expurgo_integral': False,
        'destino_parametro': 'HRD (exced. HDP)',
        'destino_expurgo': 'HRD',
        'franquia_tipo': 'POR_UG',
        'franquia_horas': 960.0,
        'aplica_uhe': True,
        'descricao': 'Ocorrências ou intervenções relativas ao início de operação comercial de unidade geradora nova.',
        'regra_excedente': 'Franquia de 960 h nos primeiros 24 meses de operação comercial; excedente vira GUM.',
    },
    {
        'codigo': 'GCI',
        'nome': 'Falta de Combustível c/ Substituição (GSUB)',
        'grupo_ons': '7.1.3.2',
        'grupo_label': '7.1.3.2 · Expurgada (entra em HDCE)',
        'impacta_taxas': False,
        'expurgo_integral': True,
        'destino_parametro': 'HDCE',
        'destino_expurgo': 'HDCE',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': False,
        'descricao': 'Restrição de combustível em UTE despachada por ordem de mérito com substituição plena por outra usina (GSUB).',
        'regra_excedente': 'Aplicável apenas a UTEs; entra em HDCE.',
    },
    # --- Item 7.1.3.3: NÃO são de responsabilidade do empreendimento (Externas -> HDCE) ---
    {
        'codigo': 'GRE',
        'nome': 'Hidráulica – Energética (Redução de Queda Útil)',
        'grupo_ons': '7.1.3.3',
        'grupo_label': '7.1.3.3 · Externa / Expurgada (entra em HDCE)',
        'impacta_taxas': False,
        'expurgo_integral': True,
        'destino_parametro': 'HDCE',
        'destino_expurgo': 'HDCE',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': (
            'Restrição de potência por redução de queda útil (níveis de montante/jusante) ou UG desligada '
            'por insuficiência de queda útil (DCO-RFO-GRE-0), registrada por unidade geradora.'
        ),
        'regra_excedente': '100% expurgada (causa externa hidráulica-energética); não penaliza TEIFa nem TEIP.',
    },
    {
        'codigo': 'GHN',
        'nome': 'Hidráulica – Navegação, Irrigação e Cheias',
        'grupo_ons': '7.1.3.3',
        'grupo_label': '7.1.3.3 · Externa / Expurgada (entra em HDCE)',
        'impacta_taxas': False,
        'expurgo_integral': True,
        'destino_parametro': 'HDCE',
        'destino_expurgo': 'HDCE',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': (
            'Restrição devido à navegação, turismo, irrigação/captações, controle de cheias e inundações, '
            'vazamento de poluentes por terceiros ou captura/salvamento de animais.'
        ),
        'regra_excedente': '100% expurgada (causa externa); entra em HDCE.',
    },
    {
        'codigo': 'GRB',
        'nome': 'Elétrica – Rede Básica / Distribuição',
        'grupo_ons': '7.1.3.3',
        'grupo_label': '7.1.3.3 · Externa / Expurgada (entra em HDCE)',
        'impacta_taxas': False,
        'expurgo_integral': True,
        'destino_parametro': 'HDCE',
        'destino_expurgo': 'HDCE',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': 'Restrição elétrica imposta pela Rede Básica, sistema de distribuição ou outras causas externas ao gerador.',
        'regra_excedente': '100% expurgada (causa externa); entra em HDCE.',
    },
]

MAPA_CLASSIFICADORES_ONS = {c['codigo']: c for c in CLASSIFICADORES_ONS}

# Siglas de revisoes anteriores ainda encontradas em planilhas antigas (alias -> oficial Rev. 47)
ALIASES_CLASSIFICADOR = {
    'GMP': 'GIS',  # Medidas preventivas de mexilhao dourado foram incorporadas em GIS na Rev. 47
}

CLASSIFICADORES_EXPURGO_INTEGRAL = {
    c['codigo'] for c in CLASSIFICADORES_ONS if c['expurgo_integral']
}
CLASSIFICADORES_DESTINO_HDCE = {
    c['codigo'] for c in CLASSIFICADORES_ONS if c['destino_expurgo'] == 'HDCE'
}
CLASSIFICADORES_CONSIDERADOS = {
    c['codigo'] for c in CLASSIFICADORES_ONS if c['impacta_taxas']
}

LIMITE_FRANQUIA_GIM_HORAS = 8760.0  # 12 meses por UG (8.784 h em ano bissexto)
TOLERANCIA_BISSEXTO_HORAS = 24.0
LIMITE_FRANQUIA_GMT_HORAS_UG = 360.0  # 360 h x N_UGs acumulado por usina

CONFIG_PADRAO = {
    'origem_manutencoes': 'excel',  # 'excel' ou 'database'
    'excel_caminho': 'dados/manutencoes/Manutencoes_e_Modernizacoes_CTG_Brasil_Plurianual.xlsm',
    'excel_aba': 'Plano',
    'database': {
        'tipo': 'postgresql',  # 'postgresql', 'duckdb', 'sqlite', 'mssql'
        'host': '',
        'porta': 5432,
        'banco': '',
        'schema': 'public',
        'tabela': 'manutencoes_programadas_ctg',
        'usuario': '',
        'senha_env': 'CALC_ID_MANUT_DB_PASSWORD',
        'caminho_arquivo': '',
        'query_customizada': '',
    },
}


def classificar_origem_ons(codigo):
    """Retorna metadados oficiais do classificador ONS (com suporte a alias historico GMP -> GIS)."""
    sigla = (codigo or '').strip().upper()
    oficial = ALIASES_CLASSIFICADOR.get(sigla, sigla)
    info = MAPA_CLASSIFICADORES_ONS.get(oficial)
    if info:
        return info
    return {
        'codigo': sigla or 'SEM_CLASS',
        'nome': 'Não classificado (tratado como GUM por conservadorismo)',
        'grupo_ons': 'NAO_CLASSIFICADA',
        'grupo_label': 'Não classificado (conservador → HDP)',
        'impacta_taxas': True,
        'expurgo_integral': False,
        'destino_parametro': 'HDP',
        'destino_expurgo': '',
        'franquia_tipo': None,
        'franquia_horas': None,
        'aplica_uhe': True,
        'descricao': 'Evento sem classificador ONS preenchido na planilha; tratado como indisponibilidade programada (HDP).',
        'regra_excedente': 'Recomenda-se preencher o classificador oficial ONS na planilha.',
    }


def destino_expurgo_por_classificador(codigo):
    """Determina o parametro ONS de destino das horas expurgadas: HDCE (7.1.3.3 e GCI) ou HRD (7.1.3.2)."""
    sigla = ALIASES_CLASSIFICADOR.get((codigo or '').strip().upper(), (codigo or '').strip().upper())
    return 'HDCE' if sigla in CLASSIFICADORES_DESTINO_HDCE else 'HRD'


def avaliar_expurgo_evento(classificador, horas_brutas, expurgo_planilha, ativa_base):
    """Aplica as regras ONS RO-AO.BR.04 Rev. 47 de expurgo de horas sobre um evento.

    Regras:
      1. Se o evento esta inativo (cancelado, auxiliar, fora do plano ou duracao <= 0): 0 h brutas e 0 h expurgo.
      2. Se a planilha informa Expurgo (horas) > 0: usa min(horas_brutas, expurgo_planilha) (evita saldo negativo).
         - Em classificadores 7.1.3.1 (ex.: GUM c/ manutencao SMF embutida), marca origem PLANILHA_MISTA.
         - Nos demais classificadores (GIM, GIS, GMT, etc.), marca origem PLANILHA.
      3. Se Expurgo (horas) esta vazio/zero na planilha, mas o classificador e de expurgo integral
         pelo ONS (GIS, GRE, GHN, GRB, GCI e alias GMP): aplica expurgo automatico de 100% das horas brutas,
         com origem CLASSIFICADOR_ONS.
      4. Caso contrario: 0 h expurgo (100% impacta HDP).
    """
    sigla = (classificador or '').strip().upper()
    oficial = ALIASES_CLASSIFICADOR.get(sigla, sigla)
    info = classificar_origem_ons(oficial)

    if not ativa_base or horas_brutas <= 0:
        return {
            'expurgo_horas': 0.0,
            'indisponibilidade_horas': 0.0,
            'expurgo_origem': 'INATIVO',
            'grupo_ons': info['grupo_ons'],
            'destino_expurgo': '',
            'destino_ons': 'INATIVO',
        }

    exp_plan = max(0.0, float(expurgo_planilha or 0.0))
    if exp_plan > 0.0:
        exp_efetivo = min(horas_brutas, exp_plan)
        origem = 'PLANILHA_MISTA' if (oficial in CLASSIFICADORES_CONSIDERADOS or not oficial) else 'PLANILHA'
    elif oficial in CLASSIFICADORES_EXPURGO_INTEGRAL:
        exp_efetivo = horas_brutas
        origem = 'CLASSIFICADOR_ONS'
    else:
        exp_efetivo = 0.0
        origem = 'NENHUM'

    indisp = max(0.0, horas_brutas - exp_efetivo)
    if indisp < 1e-6:
        indisp = 0.0
    dest_exp = destino_expurgo_por_classificador(oficial) if exp_efetivo > 0 else ''

    if exp_efetivo <= 1e-6:
        dest_ons = 'HDP'
    elif indisp <= 1e-6:
        dest_ons = dest_exp
    else:
        dest_ons = f'{dest_exp} + HDP'

    return {
        'expurgo_horas': round(exp_efetivo, 4),
        'indisponibilidade_horas': round(indisp, 4),
        'expurgo_origem': origem,
        'grupo_ons': info['grupo_ons'],
        'destino_expurgo': dest_exp,
        'destino_ons': dest_ons,
    }


def carregar_config_fontes(raiz=None):
    caminho = (Path(raiz) / 'dados/config_fontes.json') if raiz else CONFIG_FONTES
    config = json.loads(json.dumps(CONFIG_PADRAO))
    if caminho.is_file():
        try:
            salvo = json.loads(caminho.read_text(encoding='utf-8'))
            if isinstance(salvo, dict):
                for k, v in salvo.items():
                    if k == 'database' and isinstance(v, dict):
                        config['database'].update(v)
                    else:
                        config[k] = v
        except Exception:
            pass
    return config


def salvar_config_fontes(config, raiz=None):
    caminho = (Path(raiz) / 'dados/config_fontes.json') if raiz else CONFIG_FONTES
    atual = carregar_config_fontes(raiz)
    if 'origem_manutencoes' in config:
        if config['origem_manutencoes'] not in ('excel', 'database'):
            raise ValueError('Origem de manutencoes deve ser "excel" ou "database".')
        atual['origem_manutencoes'] = config['origem_manutencoes']
    if 'excel_caminho' in config and str(config['excel_caminho']).strip():
        atual['excel_caminho'] = str(config['excel_caminho']).strip()
    if 'excel_aba' in config and str(config['excel_aba']).strip():
        atual['excel_aba'] = str(config['excel_aba']).strip()
    if isinstance(config.get('database'), dict):
        for campo in ('tipo', 'host', 'porta', 'banco', 'schema', 'tabela',
                      'usuario', 'senha_env', 'caminho_arquivo', 'query_customizada'):
            if campo in config['database']:
                atual['database'][campo] = config['database'][campo]
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_text(json.dumps(atual, indent=2, ensure_ascii=False), encoding='utf-8')
    return atual


def _para_data(valor):
    if valor is None or valor == '':
        return None
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor
    texto = str(valor).strip()
    for fmt in ('%Y-%m-%d', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(texto[:19], fmt).date()
        except ValueError:
            continue
    return None


def _para_float(valor, padrao=0.0):
    if valor is None or valor == '':
        return padrao
    try:
        v = float(valor)
        return v if v == v else padrao
    except (TypeError, ValueError):
        return padrao


def _para_texto(valor):
    if valor is None:
        return ''
    return str(valor).strip()


def _sim(valor):
    return _para_texto(valor).lower() in ('sim', 's', 'true', '1', 'yes')


def _nao(valor):
    return _para_texto(valor).lower() in ('não', 'nao', 'n', 'false', '0', 'no')


def _extrair_numero_ug(ug_str):
    m = re.fullmatch(r'UG0*(\d+)', ug_str.strip(), re.I)
    return int(m.group(1)) if m else None


def _calcular_fim(inicio, duracao):
    if inicio is None or duracao is None or duracao <= 0:
        return None
    return inicio + timedelta(days=int(round(duracao)) - 1)


def ler_excel_manutencoes(caminho_excel, nome_aba='Plano'):
    """Le a planilha plurianual aplicando formulas da aba Plano e regras de expurgo ONS RO-AO.BR.04."""
    caminho = Path(caminho_excel)
    if not caminho.is_file():
        return []
    wb = openpyxl.load_workbook(caminho, data_only=True, read_only=True)
    try:
        if nome_aba not in wb.sheetnames:
            raise ValueError(f'Aba "{nome_aba}" nao encontrada na planilha ({wb.sheetnames}).')
        ws = wb[nome_aba]
        eventos = []
        for idx, row in enumerate(ws.iter_rows(min_row=3, max_col=39, values_only=True), start=3):
            sigla_uhe = _para_texto(row[2]).upper()
            ug_str = _para_texto(row[3]).upper()
            if not sigla_uhe and not ug_str:
                continue

            sigla_polo = _para_texto(row[1]).upper()
            ceg, nome_usina, polo_padrao, no_escopo_ons, _qtd_ugs = MAPA_UHE_CTG.get(
                sigla_uhe, (None, sigla_uhe, MAPA_POLO_NOME.get(sigla_polo, sigla_polo), False, 0)
            )
            polo_nome = MAPA_POLO_NOME.get(sigla_polo, polo_padrao)

            # Formula E: IF(LEN(D)=4, "Principal", "Auxiliar")
            ug_princ_val = _para_texto(row[4])
            if not ug_princ_val:
                ug_princ_val = 'Principal' if len(ug_str) == 4 else 'Auxiliar'
            ug_principal = ug_princ_val.lower() == 'principal'
            numero_ug = _extrair_numero_ug(ug_str) if ug_principal else None

            desc_abrev = _para_texto(row[5])
            desc_completa = _para_texto(row[14]) or desc_abrev
            classificador = _para_texto(row[7]).upper()
            expurgo_planilha = max(0.0, _para_float(row[8], 0.0))
            retorno_diario = _sim(row[9])
            baseline = _sim(row[10])
            gantt = _para_texto(row[11])
            tipo_manut = _para_texto(row[16]).upper()

            # Formula M: IF(AND(Q="mod", L="nao"), "Sim", IF(AND(Q="mod", L="sim"), "Nao", "Sim"))
            plano_val = _para_texto(row[12])
            if not plano_val and gantt:
                if tipo_manut == 'MOD' and _sim(gantt):
                    plano_val = 'Não'
                else:
                    plano_val = 'Sim'
            entra_plano = not _nao(plano_val)

            status_raw = _para_texto(row[13])
            cancelado = status_raw.lower() == 'cancelado'

            # Prioridade de datas: Executado > Reprogramado > Programado > Planejado
            ini_exec, dur_exec, fim_exec = _para_data(row[28]), _para_float(row[29], None), _para_data(row[30])
            ini_repr, dur_repr, fim_repr = _para_data(row[24]), _para_float(row[25], None), _para_data(row[26])
            ini_prog, dur_prog, fim_prog = _para_data(row[20]), _para_float(row[21], None), _para_data(row[22])
            ini_plan, dur_plan, fim_plan = _para_data(row[17]), _para_float(row[18], None), _para_data(row[19])

            data_inicio = _para_data(row[34]) or ini_exec or ini_repr or ini_prog or ini_plan
            data_fim = (
                _para_data(row[37])
                or fim_exec or _calcular_fim(ini_exec, dur_exec)
                or fim_repr or _calcular_fim(ini_repr, dur_repr)
                or fim_prog or _calcular_fim(ini_prog, dur_prog)
                or fim_plan or _calcular_fim(ini_plan, dur_plan)
            )
            if data_inicio and data_fim and data_fim < data_inicio:
                data_fim = data_inicio

            duracao_dias = int((data_fim - data_inicio).days + 1) if (data_inicio and data_fim) else int(_para_float(row[35], 0))
            duracao_plan_val = _para_float(row[35], None)
            if duracao_plan_val is not None and duracao_plan_val > 0:
                duracao_exata_dias = duracao_plan_val
            else:
                duracao_exata_dias = float(duracao_dias)

            # Estagio de maturidade da parada
            if cancelado:
                estagio = 'Cancelado'
            elif ini_exec is not None:
                estagio = 'Executado'
            elif ini_repr is not None:
                estagio = 'Reprogramado'
            elif ini_prog is not None:
                estagio = 'Programado'
            else:
                estagio = 'Planejado'

            ativa_base = (not cancelado) and ug_principal and entra_plano and duracao_exata_dias > 0
            taxa_dia = 12.0 if retorno_diario else 24.0
            horas_brutas = round(duracao_exata_dias * taxa_dia, 4) if ativa_base else 0.0

            regra = avaliar_expurgo_evento(classificador, horas_brutas, expurgo_planilha, ativa_base)
            expurgo_horas = regra['expurgo_horas']
            indisp_horas = regra['indisponibilidade_horas']

            ativa_no_plano = (
                ativa_base
                and no_escopo_ons
                and (numero_ug is not None)
                and (data_inicio is not None)
                and (data_fim is not None)
                and (horas_brutas > 0)
            )
            ativa_para_calculo = ativa_no_plano and (indisp_horas > 0)

            observacao = _para_texto(row[38]) or _para_texto(row[31]) or _para_texto(row[27]) or _para_texto(row[23])
            id_linha = int(_para_float(row[0], idx - 2)) if row[0] is not None else (idx - 2)

            eventos.append({
                'id_evento': id_linha,
                'sigla_polo': sigla_polo,
                'polo': polo_nome,
                'sigla_uhe': sigla_uhe,
                'cod_ceg': ceg,
                'usina': nome_usina,
                'no_escopo_ons': no_escopo_ons,
                'ug_str': ug_str,
                'numero_ug': numero_ug,
                'ug_principal': ug_principal,
                'descricao_breve': desc_abrev or desc_completa[:48],
                'descricao_completa': desc_completa,
                'classificador': classificador,
                'grupo_ons': regra['grupo_ons'],
                'destino_expurgo': regra['destino_expurgo'],
                'destino_ons': regra['destino_ons'],
                'tipo_manut': tipo_manut or 'OUTROS',
                'horas_brutas': horas_brutas,
                'expurgo_planilha_horas': round(expurgo_planilha, 4),
                'expurgo_horas': expurgo_horas,
                'expurgo_origem': regra['expurgo_origem'],
                'retorno_diario': retorno_diario,
                'baseline': baseline,
                'entra_plano': entra_plano,
                'status': 'Cancelado' if cancelado else 'Ativo',
                'estagio': estagio,
                'data_inicio': data_inicio,
                'data_fim': data_fim,
                'ano_inicio': data_inicio.year if data_inicio else None,
                'mes_inicio': data_inicio.month if data_inicio else None,
                'duracao_dias': duracao_dias,
                'indisponibilidade_horas': indisp_horas,
                'ativa_no_plano': ativa_no_plano,
                'ativa_para_calculo': ativa_para_calculo,
                'observacao': observacao,
                'origem_dado': 'EXCEL',
            })
        return eventos
    finally:
        wb.close()


def agregar_manutencoes_mensal(eventos):
    """Rateia eventos dia-a-dia por UG/mes com consumo cronologico de expurgo e precedencia ONS.

    Conformidade ONS RO-AO.BR.04 Rev. 47:
      - Item 5.2.4: a franquia de expurgo e consumida de forma continua/cronologica a partir do inicio
        da intervencao; somente o saldo excedente apos o termino da franquia entra como GUM (HDP).
      - Item 5.2.7: em sobreposicoes na mesma UG no mesmo dia, origens desconsideradas (7.1.3.2 HRD
        e 7.1.3.3 HDCE) prevalecem sobre origens consideradas (7.1.3.1 HDP), com teto de 24 h/dia.
      - Anexo 3: expurgos de 7.1.3.2 (GIS, GIM, GMT, GIC) alimentam HRD; expurgos de 7.1.3.3
        (GRE, GHN, GRB) e GCI alimentam HDCE; horas liquidas nao expurgadas alimentam HDP.
    """
    dias_bloqueio = defaultdict(float)  # max horas paradas no dia (cap 24h)
    dias_hrd = defaultdict(float)       # max horas expurgadas HRD no dia (7.1.3.2)
    dias_hdce = defaultdict(float)      # max horas expurgadas HDCE no dia (7.1.3.3 / GCI)
    mes_eventos = defaultdict(list)     # (cod_ceg, usina, numero_ug, mes_date) -> list[dict]

    for ev in eventos:
        ativa_plano = ev.get('ativa_no_plano')
        if ativa_plano is None:
            ativa_plano = bool(ev.get('ativa_para_calculo'))
        if not ativa_plano:
            continue
        ini = ev.get('data_inicio')
        fim = ev.get('data_fim')
        if ini is None or fim is None:
            continue
        dur = (fim - ini).days + 1
        if dur <= 0:
            continue

        indisp_ev = max(0.0, float(ev.get('indisponibilidade_horas') or 0.0))
        exp_ev = max(0.0, float(ev.get('expurgo_horas') or 0.0))
        bruto_ev = ev.get('horas_brutas')
        if bruto_ev is None:
            bruto_ev = indisp_ev + exp_ev
        bruto_ev = max(0.0, float(bruto_ev))
        if bruto_ev <= 0.0:
            continue

        taxa_dia = min(24.0, bruto_ev / dur)
        exp_restante = min(bruto_ev, exp_ev)
        dest_exp = ev.get('destino_expurgo') or destino_expurgo_por_classificador(ev.get('classificador'))

        meses_vistos = set()
        d = ini
        while d <= fim:
            exp_d = min(taxa_dia, exp_restante)
            ind_d = max(0.0, taxa_dia - exp_d)
            exp_restante = max(0.0, exp_restante - exp_d)

            chave_dia = (ev['cod_ceg'], ev['usina'], ev['numero_ug'], d)
            bloq_d = min(24.0, exp_d + ind_d)
            if bloq_d > dias_bloqueio[chave_dia]:
                dias_bloqueio[chave_dia] = bloq_d

            if exp_d > 0.0:
                if dest_exp == 'HDCE':
                    if exp_d > dias_hdce[chave_dia]:
                        dias_hdce[chave_dia] = min(24.0, exp_d)
                else:
                    if exp_d > dias_hrd[chave_dia]:
                        dias_hrd[chave_dia] = min(24.0, exp_d)

            mes_dt = date(d.year, d.month, 1)
            if mes_dt not in meses_vistos:
                meses_vistos.add(mes_dt)
                mes_eventos[(ev['cod_ceg'], ev['usina'], ev['numero_ug'], mes_dt)].append(ev)
            d += timedelta(days=1)

    agregado = defaultdict(lambda: {
        'bruto': 0.0, 'hdp': 0.0, 'hrd': 0.0, 'hdce': 0.0, 'expurgo': 0.0, 'dias': 0, 'dias_hdp': 0
    })
    for chave_dia, bloq_raw in dias_bloqueio.items():
        ceg, usina, ug, d = chave_dia
        hdce_d = min(24.0, dias_hdce.get(chave_dia, 0.0))
        hrd_d = min(max(0.0, 24.0 - hdce_d), dias_hrd.get(chave_dia, 0.0))
        exp_d = hdce_d + hrd_d
        bloq_d = min(24.0, max(bloq_raw, exp_d))
        hdp_d = max(0.0, bloq_d - exp_d)

        chave_mes = (ceg, usina, ug, date(d.year, d.month, 1))
        slot = agregado[chave_mes]
        slot['bruto'] += bloq_d
        slot['hdp'] += hdp_d
        slot['hrd'] += hrd_d
        slot['hdce'] += hdce_d
        slot['expurgo'] += exp_d
        if bloq_d > 1e-6:
            slot['dias'] += 1
        if hdp_d > 1e-6:
            slot['dias_hdp'] += 1

    linhas = []
    for (ceg, usina, ug, mes_dt), vals in sorted(agregado.items()):
        evs = mes_eventos[(ceg, usina, ug, mes_dt)]
        tipos = sorted({e.get('tipo_manut') for e in evs if e.get('tipo_manut')})
        classifs = sorted({(e.get('classificador') or 'SEM_CLASS') for e in evs})
        resumo = ' | '.join(
            dict.fromkeys(
                f"{e.get('tipo_manut') or 'MANUT'}"
                f"{' [' + e['classificador'] + ']' if e.get('classificador') else ''}: "
                f"{e.get('descricao_breve') or ''}"
                for e in evs
            )
        )[:260]
        linhas.append({
            'cod_ceg': ceg,
            'usina': usina,
            'numero_ug': ug,
            'mes': mes_dt,
            'horas_brutas': round(vals['bruto'], 4),
            'hdp_programado': round(vals['hdp'], 4),
            'hrd_expurgado': round(vals['hrd'], 4),
            'hdce_expurgado': round(vals['hdce'], 4),
            'dias_parados': vals['dias'],
            'dias_hdp': vals['dias_hdp'],
            'horas_expurgadas': round(vals['expurgo'], 4),
            'qtd_eventos': len(evs),
            'tipos_manut': ', '.join(tipos),
            'classificadores': ', '.join(classifs),
            'tem_mod': any(e.get('tipo_manut') == 'MOD' for e in evs),
            'tem_mpp': any(str(e.get('tipo_manut') or '').startswith('MPP') for e in evs),
            'eventos_resumo': resumo,
        })
    return linhas


def calcular_auditoria_franquias(eventos):
    """Audita o consumo acumulado das franquias regulatorias ONS (GIM 12m/UG e GMT 360h/UG por usina)."""
    gim_por_ug = defaultdict(lambda: {'qtd': 0, 'bruto': 0.0, 'expurgo': 0.0, 'hdp': 0.0, 'anos': set()})
    gmt_por_usina = defaultdict(lambda: {'qtd': 0, 'bruto': 0.0, 'expurgo': 0.0, 'hdp': 0.0, 'anos': set(), 'sigla': ''})

    for ev in eventos:
        if not ev.get('ativa_no_plano'):
            continue
        cls = (ev.get('classificador') or '').strip().upper()
        if cls == 'GIM':
            chave = (ev['cod_ceg'], ev['usina'], ev['numero_ug'])
            s = gim_por_ug[chave]
            s['qtd'] += 1
            s['bruto'] += ev['horas_brutas']
            s['expurgo'] += ev['expurgo_horas']
            s['hdp'] += ev['indisponibilidade_horas']
            if ev.get('ano_inicio'):
                s['anos'].add(ev['ano_inicio'])
        elif cls == 'GMT':
            chave = (ev['cod_ceg'], ev['usina'])
            s = gmt_por_usina[chave]
            s['qtd'] += 1
            s['bruto'] += ev['horas_brutas']
            s['expurgo'] += ev['expurgo_horas']
            s['hdp'] += ev['indisponibilidade_horas']
            s['sigla'] = ev['sigla_uhe']
            if ev.get('ano_inicio'):
                s['anos'].add(ev['ano_inicio'])

    linhas = []
    for (ceg, usina, ug), s in sorted(gim_por_ug.items()):
        limite = LIMITE_FRANQUIA_GIM_HORAS
        saldo = limite - s['expurgo']
        uso_pct = 100.0 * s['expurgo'] / limite if limite > 0 else 0.0
        if s['expurgo'] > limite + TOLERANCIA_BISSEXTO_HORAS:
            status = 'EXCEDIDO'
        elif uso_pct >= 85.0:
            status = 'NO_LIMITE'
        else:
            status = 'OK'
        anos_ord = sorted(s['anos'])
        periodo = f'{anos_ord[0]}–{anos_ord[-1]}' if len(anos_ord) > 1 else (str(anos_ord[0]) if anos_ord else '—')
        linhas.append({
            'classificador': 'GIM',
            'escopo': 'Por UG (12 meses / outorga)',
            'cod_ceg': ceg,
            'usina': usina,
            'numero_ug': ug,
            'qtd_eventos': s['qtd'],
            'periodo_anos': periodo,
            'horas_brutas': round(s['bruto'], 2),
            'horas_expurgo_declarado': round(s['expurgo'], 2),
            'horas_hdp_excedente': round(s['hdp'], 2),
            'limite_franquia_horas': limite,
            'saldo_franquia_horas': round(saldo, 2),
            'uso_franquia_pct': round(uso_pct, 2),
            'status': status,
        })

    for (ceg, usina), s in sorted(gmt_por_usina.items()):
        qtd_ugs = MAPA_UHE_CTG.get(s['sigla'], (None, '', '', False, 1))[4] or 1
        limite = LIMITE_FRANQUIA_GMT_HORAS_UG * qtd_ugs
        saldo = limite - s['expurgo']
        uso_pct = 100.0 * s['expurgo'] / limite if limite > 0 else 0.0
        if s['expurgo'] > limite:
            status = 'EXCEDIDO'
        elif uso_pct >= 85.0:
            status = 'NO_LIMITE'
        else:
            status = 'OK'
        anos_ord = sorted(s['anos'])
        periodo = f'{anos_ord[0]}–{anos_ord[-1]}' if len(anos_ord) > 1 else (str(anos_ord[0]) if anos_ord else '—')
        linhas.append({
            'classificador': 'GMT',
            'escopo': f'Por Usina (360 h × {qtd_ugs} UGs)',
            'cod_ceg': ceg,
            'usina': usina,
            'numero_ug': None,
            'qtd_eventos': s['qtd'],
            'periodo_anos': periodo,
            'horas_brutas': round(s['bruto'], 2),
            'horas_expurgo_declarado': round(s['expurgo'], 2),
            'horas_hdp_excedente': round(s['hdp'], 2),
            'limite_franquia_horas': limite,
            'saldo_franquia_horas': round(saldo, 2),
            'uso_franquia_pct': round(uso_pct, 2),
            'status': status,
        })

    linhas.sort(key=lambda r: (0 if r['status'] == 'EXCEDIDO' else 1 if r['status'] == 'NO_LIMITE' else 2, -r['uso_franquia_pct'], r['usina'], r['numero_ug'] or 0))
    return linhas


def testar_conexao_banco(db_cfg):
    """Testa conectividade com banco externo configurado para manutencoes."""
    import os
    tipo = (db_cfg.get('tipo') or '').lower()
    if tipo == 'duckdb':
        import duckdb
        caminho = db_cfg.get('caminho_arquivo') or ''
        if not caminho:
            raise ValueError('Informe o caminho do arquivo DuckDB.')
        with duckdb.connect(caminho, read_only=True) as con:
            con.execute('SELECT 1').fetchone()
        return f'Conexao DuckDB OK ({caminho}).'
    if tipo == 'sqlite':
        import sqlite3
        caminho = db_cfg.get('caminho_arquivo') or ''
        if not caminho:
            raise ValueError('Informe o caminho do arquivo SQLite.')
        with sqlite3.connect(caminho) as con:
            con.execute('SELECT 1').fetchone()
        return f'Conexao SQLite OK ({caminho}).'
    if tipo == 'postgresql':
        try:
            import psycopg2
        except ImportError as erro:
            raise RuntimeError('Pacote psycopg2 nao instalado neste ambiente.') from erro
        host = db_cfg.get('host') or ''
        banco = db_cfg.get('banco') or ''
        if not host or not banco:
            raise ValueError('Informe host e nome do banco PostgreSQL.')
        senha_env = db_cfg.get('senha_env') or 'CALC_ID_MANUT_DB_PASSWORD'
        senha = os.environ.get(senha_env, '')
        with psycopg2.connect(
            host=host,
            port=int(db_cfg.get('porta') or 5432),
            dbname=banco,
            user=db_cfg.get('usuario') or '',
            password=senha,
            connect_timeout=5,
        ) as con:
            with con.cursor() as cur:
                cur.execute('SELECT 1')
                cur.fetchone()
        return f'Conexao PostgreSQL OK ({host}:{db_cfg.get("porta", 5432)}/{banco}).'
    raise ValueError(f'Tipo de banco nao suportado para teste direto: {tipo}.')


def carregar_manutencoes(con, raiz, caminho_excel=None):
    """Carrega manutencoes, rateio mensal c/ expurgos ONS e auditoria de franquias no DuckDB."""
    raiz = Path(raiz)
    cfg = carregar_config_fontes(raiz)
    if caminho_excel:
        arquivo = Path(caminho_excel)
        if not arquivo.is_absolute():
            arquivo = raiz / arquivo
    else:
        rel = cfg.get('excel_caminho') or ARQUIVO_MANUTENCOES_PADRAO.relative_to(raiz).as_posix()
        arquivo = Path(rel)
        if not arquivo.is_absolute():
            arquivo = raiz / arquivo

    eventos = ler_excel_manutencoes(arquivo, cfg.get('excel_aba', 'Plano')) if arquivo.is_file() else []
    mensais = agregar_manutencoes_mensal(eventos)
    franquias = calcular_auditoria_franquias(eventos)

    con.execute('''
        CREATE OR REPLACE TABLE manutencoes_programadas (
            id_evento INTEGER,
            sigla_polo VARCHAR,
            polo VARCHAR,
            sigla_uhe VARCHAR,
            cod_ceg VARCHAR,
            usina VARCHAR,
            no_escopo_ons BOOLEAN,
            ug_str VARCHAR,
            numero_ug INTEGER,
            ug_principal BOOLEAN,
            descricao_breve VARCHAR,
            descricao_completa VARCHAR,
            classificador VARCHAR,
            grupo_ons VARCHAR,
            destino_expurgo VARCHAR,
            destino_ons VARCHAR,
            tipo_manut VARCHAR,
            horas_brutas DOUBLE,
            expurgo_planilha_horas DOUBLE,
            expurgo_horas DOUBLE,
            expurgo_origem VARCHAR,
            retorno_diario BOOLEAN,
            baseline BOOLEAN,
            entra_plano BOOLEAN,
            status VARCHAR,
            estagio VARCHAR,
            data_inicio DATE,
            data_fim DATE,
            ano_inicio INTEGER,
            mes_inicio INTEGER,
            duracao_dias INTEGER,
            indisponibilidade_horas DOUBLE,
            ativa_no_plano BOOLEAN,
            ativa_para_calculo BOOLEAN,
            observacao VARCHAR,
            origem_dado VARCHAR
        )
    ''')
    if eventos:
        con.executemany(
            'INSERT INTO manutencoes_programadas VALUES (' + ','.join(['?'] * 36) + ')',
            [
                (
                    e['id_evento'], e['sigla_polo'], e['polo'], e['sigla_uhe'], e['cod_ceg'],
                    e['usina'], e['no_escopo_ons'], e['ug_str'], e['numero_ug'], e['ug_principal'],
                    e['descricao_breve'], e['descricao_completa'], e['classificador'],
                    e['grupo_ons'], e['destino_expurgo'], e['destino_ons'], e['tipo_manut'],
                    e['horas_brutas'], e['expurgo_planilha_horas'], e['expurgo_horas'], e['expurgo_origem'],
                    e['retorno_diario'], e['baseline'], e['entra_plano'],
                    e['status'], e['estagio'], e['data_inicio'], e['data_fim'], e['ano_inicio'],
                    e['mes_inicio'], e['duracao_dias'], e['indisponibilidade_horas'],
                    e['ativa_no_plano'], e['ativa_para_calculo'], e['observacao'], e['origem_dado'],
                )
                for e in eventos
            ],
        )

    con.execute('''
        CREATE OR REPLACE TABLE manutencoes_ug_mensal (
            cod_ceg VARCHAR,
            usina VARCHAR,
            numero_ug INTEGER,
            mes DATE,
            horas_brutas DOUBLE,
            hdp_programado DOUBLE,
            hrd_expurgado DOUBLE,
            hdce_expurgado DOUBLE,
            dias_parados INTEGER,
            dias_hdp INTEGER,
            horas_expurgadas DOUBLE,
            qtd_eventos INTEGER,
            tipos_manut VARCHAR,
            classificadores VARCHAR,
            tem_mod BOOLEAN,
            tem_mpp BOOLEAN,
            eventos_resumo VARCHAR
        )
    ''')
    if mensais:
        con.executemany(
            'INSERT INTO manutencoes_ug_mensal VALUES (' + ','.join(['?'] * 17) + ')',
            [
                (
                    m['cod_ceg'], m['usina'], m['numero_ug'], m['mes'],
                    m['horas_brutas'], m['hdp_programado'], m['hrd_expurgado'], m['hdce_expurgado'],
                    m['dias_parados'], m['dias_hdp'], m['horas_expurgadas'], m['qtd_eventos'],
                    m['tipos_manut'], m['classificadores'], m['tem_mod'], m['tem_mpp'], m['eventos_resumo'],
                )
                for m in mensais
            ],
        )

    con.execute('''
        CREATE OR REPLACE TABLE auditoria_franquias_ons (
            classificador VARCHAR,
            escopo VARCHAR,
            cod_ceg VARCHAR,
            usina VARCHAR,
            numero_ug INTEGER,
            qtd_eventos INTEGER,
            periodo_anos VARCHAR,
            horas_brutas DOUBLE,
            horas_expurgo_declarado DOUBLE,
            horas_hdp_excedente DOUBLE,
            limite_franquia_horas DOUBLE,
            saldo_franquia_horas DOUBLE,
            uso_franquia_pct DOUBLE,
            status VARCHAR
        )
    ''')
    if franquias:
        con.executemany(
            'INSERT INTO auditoria_franquias_ons VALUES (' + ','.join(['?'] * 14) + ')',
            [
                (
                    f['classificador'], f['escopo'], f['cod_ceg'], f['usina'], f['numero_ug'],
                    f['qtd_eventos'], f['periodo_anos'], f['horas_brutas'],
                    f['horas_expurgo_declarado'], f['horas_hdp_excedente'],
                    f['limite_franquia_horas'], f['saldo_franquia_horas'],
                    f['uso_franquia_pct'], f['status'],
                )
                for f in franquias
            ],
        )

    return len(eventos), len(mensais)
