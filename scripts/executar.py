"""Atualiza dados do ONS, executa o SQL no DuckDB, integra manutencoes e exporta os resultados."""
import argparse
from datetime import date
from pathlib import Path
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

import duckdb

# Permite tanto `python scripts/executar.py` quanto `python -m scripts.executar`.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.app.caminhos import BANCO_PADRAO, HTML_PAINEL, RAIZ, TABELAS_RESULTADOS, caminho_tabela
from scripts.app.manutencoes import carregar_manutencoes
from scripts.app.projecao_sin import calcular_projecao_sin
from scripts.app.referencias import atualizar_referencias


BASE_URL = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/'


def argumentos(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modo = parser.add_mutually_exclusive_group()
    modo.add_argument('--atualizar', action='store_true',
                      help='Baixa parametros, cadastro de potencia e taxas ONS antes de calcular.')
    modo.add_argument('--somente-baixar', action='store_true',
                      help='Atualiza os arquivos do ONS sem executar os calculos.')
    parser.add_argument('--ano-inicial', type=int, default=2020,
                        help='Primeiro ano de parametros a baixar (padrao: 2020).')
    parser.add_argument('--ano-final', type=int, default=date.today().year,
                        help='Ultimo ano de parametros a baixar (padrao: ano atual).')
    parser.add_argument('--banco', default=BANCO_PADRAO.as_posix())
    parser.add_argument('--referencias-url',
                        help='Nova fonte oficial FID. Sem esta opcao, reutiliza a fonte registrada no Parquet.')
    parser.add_argument('--manutencoes',
                        help='Caminho alternativo para a planilha Excel de manutencoes programadas.')
    parser.add_argument('--painel', action='store_true',
                        help='Abre o painel e permite salvar cenarios em Parquet e acessar a aba Administrador.')
    parser.add_argument('--porta', type=int, default=8765, help='Porta local do painel (padrao: 8765).')
    parser.add_argument('--host', default='127.0.0.1',
                        help='Endereco de escuta do servidor (use 0.0.0.0 para acessar pelo celular na rede Wi-Fi).')
    parser.add_argument('--sync-mobile', action='store_true',
                        help='Atualiza o bundle mobile/www/ para o app nativo Capacitor (Android/iOS).')
    args = parser.parse_args(argv)
    if args.ano_inicial > args.ano_final:
        parser.error('--ano-inicial deve ser menor ou igual a --ano-final')
    return args


def baixar_arquivo(recurso, destino):
    """So substitui um arquivo local depois de receber um Parquet completo."""
    with urlopen(BASE_URL + recurso, timeout=60) as resposta:
        conteudo = resposta.read()
    if not (conteudo.startswith(b'PAR1') and conteudo.endswith(b'PAR1')):
        raise ValueError(f'{destino.name}: resposta nao e um Parquet valido')
    destino.parent.mkdir(parents=True, exist_ok=True)
    temporario = destino.with_suffix(destino.suffix + '.tmp')
    temporario.write_bytes(conteudo)
    temporario.replace(destino)
    print(f'OK: {destino.name} ({len(conteudo)} bytes)', flush=True)


def atualizar_dados(raiz, ano_inicial, ano_final):
    ano_corrente = date.today().year
    for ano in range(ano_inicial, ano_final + 1):
        nome = f'TAXA_TEIF_TEIP_PARAM_{ano}.parquet'
        try:
            baixar_arquivo(f'taxa_teif_teip_parametro/{nome}', raiz / 'dados/ons/parametros' / nome)
        except HTTPError as erro:
            if erro.code == 404 and ano >= ano_corrente:
                print(f'Aviso: {nome} ainda nao publicado pelo ONS (HTTP 404); mantendo anos disponiveis.', flush=True)
                continue
            raise
    for pasta, subpasta, nome in (
        ('capacidade-geracao', 'cadastro', 'CAPACIDADE_GERACAO.parquet'),
        ('taxa_teif_teip', 'taxas', 'TAXA_TEIF_TEIP.parquet'),
    ):
        baixar_arquivo(f'{pasta}/{nome}', raiz / 'dados/ons' / subpasta / nome)


def main(argv=None):
    args = argumentos(argv)
    raiz = RAIZ
    os.chdir(raiz)
    if args.atualizar or args.somente_baixar:
        # Uma falha no download do ONS interrompe a execucao antes do calculo.
        atualizar_dados(raiz, args.ano_inicial, args.ano_final)
        ref_local = raiz / 'dados/mme/REFERENCIAS_FID.parquet'
        try:
            atualizar_referencias(raiz, args.referencias_url)
        except (URLError, HTTPError, TimeoutError, OSError) as erro:
            if args.referencias_url or not ref_local.is_file():
                raise
            print(f'Aviso: falha de rede ao consultar MME ({erro}); mantendo REFERENCIAS_FID.parquet local.', flush=True)
    if args.somente_baixar:
        print('Download concluido. Para calcular: python scripts/executar.py', flush=True)
        return
    if not (raiz / 'dados/mme/REFERENCIAS_FID.parquet').exists():
        raise SystemExit('Referencias FID ausentes. Execute python scripts/executar.py --atualizar.')
    Path('resultados').mkdir(exist_ok=True)
    Path(args.banco).parent.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(args.banco) as con:
        # Cada etapa e atomica. Tabelas de referencia e potencia sao preservadas.
        con.execute('BEGIN')
        try:
            for arquivo in ('01_fontes.sql', '02_calculo.sql', '04_produtos.sql'):
                con.execute((raiz / 'scripts/sql' / arquivo).read_text(encoding='utf-8'))
            qtd_ev, qtd_mes = carregar_manutencoes(con, raiz, args.manutencoes)
            calcular_projecao_sin(con, raiz)
            con.execute('COMMIT')
        except Exception:
            con.execute('ROLLBACK')
            raise
        print(f'Manutencoes integradas: {qtd_ev} eventos | {qtd_mes} registros UG/mes', flush=True)
        for nome in TABELAS_RESULTADOS:
            destino = caminho_tabela(nome)
            destino.parent.mkdir(parents=True, exist_ok=True)
            con.execute(f'COPY (SELECT * FROM {nome} ORDER BY ALL) TO ? '
                        '(FORMAT PARQUET, COMPRESSION ZSTD)', [str(destino)])
        # Remover somente as exportacoes CSV substituidas, dentro de resultados/.
        for arquivo in (raiz / 'resultados').glob('*.csv'):
            arquivo.unlink()
        from scripts.app.painel import gerar_html
        gerar_html(con, raiz)
        print('Banco:', args.banco, flush=True)
        for linha in con.execute('''
            SELECT usina, round(teifa_pct,6), round(teip_pct,6), meses_validos
            FROM taxas_60_meses_ctg
            WHERE mes_fim_historico=(SELECT max(mes_fim_historico) FROM taxas_60_meses_ctg)
            ORDER BY usina
        ''').fetchall():
            print(linha, flush=True)
        print('Conciliacao do ultimo mes:', flush=True)
        for linha in con.execute('''
            SELECT status,count(*) FROM conciliacao_ons
            WHERE operada_ctg AND mes_fim_historico=(SELECT max(mes_fim_historico) FROM taxas_60_meses)
            GROUP BY status ORDER BY status
        ''').fetchall():
            print(linha, flush=True)
    print('Painel:', HTML_PAINEL.as_posix(), flush=True)
    if args.sync_mobile or (raiz / 'mobile/capacitor.config.json').is_file():
        from scripts.app.mobile import exportar_bundle_mobile
        destino_mob = exportar_bundle_mobile(raiz)
        print('Bundle Mobile:', destino_mob.relative_to(raiz).as_posix(), flush=True)
    if args.painel:
        from scripts.app.painel import servir
        servir(raiz, args.porta, host=args.host)


if __name__ == '__main__':
    main()
