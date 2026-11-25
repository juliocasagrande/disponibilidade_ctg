"""Converte as referencias oficiais do MME em Parquet, sem guardar PDFs."""
from datetime import date, datetime, timezone
from hashlib import sha256
from pathlib import Path
import re
from urllib.request import Request, urlopen

import duckdb
import pymupdf


URL_REFERENCIA = ('https://www.gov.br/mme/pt-br/acesso-a-informacao/legislacao/'
                  'portarias/2022/portaria-n-709-gm-mme-2022.pdf/@@download/file')
MESES = dict(zip(('janeiro','fevereiro','março','abril','maio','junho','julho',
                 'agosto','setembro','outubro','novembro','dezembro'), range(1,13)))


def extrair_referencias(conteudo, url):
    with pymupdf.open(stream=conteudo, filetype='pdf') as pdf:
        texto = ' '.join(' '.join(p.get_text(sort=True).split()) for p in pdf)
    inicio = re.search(r'v[aá]lidos a partir de\s+(\d+)[ºo]?\s+de\s+(\w+)\s+de\s+(\d{4})', texto, re.I)
    if not inicio:
        raise ValueError('A portaria nao informa uma vigencia reconhecida. Referencias anteriores preservadas.')
    dia, mes, ano = inicio.groups()
    vigencia = date(int(ano), MESES[mes.lower()], int(dia))
    padrao = r'(UHE\.PH\.[A-Z]{2}\.\d{6}-\d\.\d{2})\s+(.+?)\s+(\d+,\d{3})\s+(\d+,\d{3})\s+[\d.,]+'
    linhas = []
    instante = datetime.now(timezone.utc)
    for ceg, nome, teif, ip in re.findall(padrao, texto):
        f, p = float(teif.replace(',','.'))/100, float(ip.replace(',','.'))/100
        if not (0 <= f < 1 and 0 <= p < 1):
            raise ValueError(f'Referencia invalida: {ceg}')
        linhas.append((ceg, nome, f, p, (1-f)*(1-p), vigencia, url,
                       sha256(conteudo).hexdigest(), instante))
    # O anexo repete o CEG de Itiquira I/II. Preservar a publicacao original;
    # a validacao de unicidade e feita para as usinas CTG ao carregar o produto.
    if not linhas or len({(r[0],r[1]) for r in linhas}) != len(linhas):
        raise ValueError('Tabela de referencias ausente ou linhas duplicadas.')
    return linhas


def atualizar_referencias(raiz, url=None):
    pasta = Path(raiz) / 'dados/mme'
    pasta.mkdir(parents=True, exist_ok=True)
    destino = pasta / 'REFERENCIAS_FID.parquet'
    temporario = pasta / 'REFERENCIAS_FID.parquet.tmp'
    if url is None and destino.exists():
        with duckdb.connect() as con:
            colunas = [c[0] for c in con.execute('DESCRIBE SELECT * FROM read_parquet(?)',[str(destino)]).fetchall()]
            campo = 'url_atualizacao' if 'url_atualizacao' in colunas else 'fonte_url'
            fontes = con.execute(f'SELECT DISTINCT {campo} FROM read_parquet(?)',[str(destino)]).fetchall()
            if len(fontes)!=1 or not fontes[0][0]:
                raise ValueError('Informe --referencias-url para atualizar esta base de referencias.')
            url = fontes[0][0]
    url = url or URL_REFERENCIA
    request = Request(url, headers={'User-Agent':'Calc_ID/1.0'})
    with urlopen(request, timeout=60) as resposta:
        conteudo = resposta.read()
    with duckdb.connect() as con:
        if conteudo.startswith(b'PAR1'):
            # Uma fonte oficial Parquet tambem pode ser indicada explicitamente.
            temporario.write_bytes(conteudo)
            con.execute('SELECT cod_ceg,teif_referencia,ip_referencia,id_referencia,inicio_vigencia '
                        'FROM read_parquet(?) LIMIT 1', [str(temporario)])
            con.execute('CREATE TABLE referencias AS FROM read_parquet(?)',[str(temporario)])
        else:
            linhas = extrair_referencias(conteudo, url)
            con.execute('''CREATE TABLE referencias (
                cod_ceg VARCHAR, nome_usina_fonte VARCHAR, teif_referencia DOUBLE,
                ip_referencia DOUBLE, id_referencia DOUBLE, inicio_vigencia DATE,
                fonte_url VARCHAR, sha256_fonte VARCHAR, consulta_utc TIMESTAMPTZ)''')
            con.executemany('INSERT INTO referencias VALUES (?,?,?,?,?,?,?,?,?)', linhas)
        con.execute('ALTER TABLE referencias ADD COLUMN IF NOT EXISTS url_atualizacao VARCHAR')
        con.execute('UPDATE referencias SET url_atualizacao=?',[url])
        con.execute('COPY referencias TO ? (FORMAT PARQUET, COMPRESSION ZSTD)', [str(temporario)])
        temporario.replace(destino)
    print(f'OK: {destino.name} (referencias oficiais MME)')
