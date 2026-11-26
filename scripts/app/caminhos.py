"""Pastas do projeto e destinos das tabelas exportadas."""
from pathlib import Path


RAIZ = Path(__file__).resolve().parents[2]
PASTA_SQL = RAIZ / 'scripts/sql'
PASTA_PAINEL = RAIZ / 'scripts/painel'
PASTA_DADOS = RAIZ / 'dados'
PASTA_RESULTADOS = RAIZ / 'resultados'

BANCO_PADRAO = Path('resultados/banco/indicadores.duckdb')
HTML_PAINEL = Path('resultados/painel/painel.html')

PASTA_MANUTENCOES = PASTA_DADOS / 'manutencoes'
ARQUIVO_MANUTENCOES_PADRAO = PASTA_MANUTENCOES / 'Manutencoes_e_Modernizacoes_CTG_Brasil_Plurianual.xlsm'
ARQUIVO_MANUTENCOES_ADICIONAIS = PASTA_MANUTENCOES / 'manutencoes_adicionais.json'

PASTA_SIN = PASTA_DADOS / 'referencias_sin'
ARQUIVO_SIN_EXCEL = PASTA_SIN / 'Projecao_Disponibilidade_2028_SIN.xlsx'
ARQUIVO_SIN_PARQUET = PASTA_SIN / 'CADASTRO_SIN_FAIXAS.parquet'
ARQUIVO_VALIDACAO_2022_PARQUET = PASTA_SIN / 'VALIDACAO_2022_FAIXAS.parquet'

CONFIG_FONTES = PASTA_DADOS / 'config_fontes.json'
CONFIG_ADMIN = PASTA_DADOS / 'admin_config.json'

GRUPOS_RESULTADOS = {
    'intermediarias': (
        'horas_ug_mensal_ctg',
        'parcelas_usina_mensal_ctg',
        'referencias_fid_ctg',
        'manutencoes_programadas',
        'manutencoes_ug_mensal',
    ),
    'consolidadas': (
        'taxas_mensais_ctg',
        'taxas_60_meses_ctg',
        'indicadores_disponibilidade_ctg',
        'projecao_faixas_sin',
        'analise_ctg_faixas',
    ),
    'validacoes': (
        'conciliacao_ons',
        'auditoria_ugs',
        'auditoria_parametros',
        'auditoria_fechamento_horas',
        'auditoria_franquias_ons',
    ),
}
TABELAS_RESULTADOS = {
    tabela: Path(grupo) / f'{tabela}.parquet'
    for grupo, tabelas in GRUPOS_RESULTADOS.items()
    for tabela in tabelas
}


def caminho_tabela(tabela, pasta_resultados=PASTA_RESULTADOS):
    return Path(pasta_resultados) / TABELAS_RESULTADOS[tabela]
