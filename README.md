# Cálculo de TEIFa e TEIP no DuckDB

O projeto calcula as taxas de indisponibilidade por usina, a partir das horas de cada unidade geradora, com resultados mensais e acumulados em 60 meses. O filtro padrão abrange 68 UGs de 12 UHEs operadas pela CTG Brasil. A tabela consolidada principal é `resultados/consolidadas/indicadores_disponibilidade_ctg.parquet`, com TEIFa, TEIP, ID verificado, referência e FID.

## Estrutura do projeto

```text
Calc_ID/
├── scripts/
│   ├── executar.py              # Atualização, cálculo e exportação
│   ├── app/                     # Módulos Python e mapa de caminhos
│   ├── sql/                     # Fontes, cálculos, produtos e simulação
│   └── painel/                  # HTML, CSS e JavaScript do painel
├── dados/
│   ├── ons/
│   │   ├── parametros/          # Parquets anuais de horas por UG
│   │   ├── cadastro/            # Cadastro e potência das UGs
│   │   └── taxas/               # Taxas publicadas para conciliação
│   └── mme/                     # Referências oficiais da garantia física
├── resultados/
│   ├── intermediarias/          # Horas por UG, parcelas e referências CTG
│   ├── consolidadas/            # Taxas mensais, de 60 meses e indicadores
│   ├── validacoes/              # Conciliação e auditorias
│   │   └── painel/              # Evidências do teste de navegador
│   ├── banco/                   # indicadores.duckdb
│   ├── painel/                  # painel.html pronto para abrir
│   └── cenarios/                # Projeções salvas pelo usuário
├── tests/                       # Testes de cálculo, dados e navegador
├── executar.py                  # Atalho compatível com o comando anterior
├── requirements.txt
└── README.md
```

Os destinos dos Parquets são definidos em `scripts/app/caminhos.py`. O processamento grava cada tabela na sua categoria e preserva as tabelas de potência e referência informadas no banco. Os arquivos existentes foram movidos para essas pastas, incluindo o banco e os cenários.

## Fórmulas e período de cálculo

Para uma usina e um conjunto de meses `J`, as parcelas são ponderadas pela potência nominal `P` de cada UG:

```text
TEIFa = SUM(P * (HDF + HEDF)) / SUM(P * (HDF + HEDF + HS + HDCE + HRD))
TEIP  = SUM(P * (HDP + HEDP)) / SUM(P * HP)
```

No resultado mensal, `J` contém um mês. No acumulado, contém 60 meses consecutivos. Portanto, o acumulado deve dividir as somas de numeradores e denominadores; uma média das taxas mensais pode produzir outro valor. A formulação consta do Anexo 3 da [rotina ONS RO-AO.BR.04, revisão 47, vigente em 25/06/2026](https://www.ons.org.br/MPO/Documento%20Normativo/4.%20Rotinas%20Operacionais%20-%20SM%205.13/4.3.%20Rotinas%20P%C3%B3s-Opera%C3%A7%C3%A3o/4.3.2.%20Apura%C3%A7%C3%A3o%20de%20Dados/RO-AO.BR.04_Rev.47.pdf), que remete à REN ANEEL 1.033/2022.

| Campo | Significado |
| --- | --- |
| HDF | Horas de desligamento forçado |
| HEDF | Horas equivalentes de desligamento forçado por restrição parcial |
| HDP | Horas de desligamento programado |
| HEDP | Horas equivalentes de desligamento programado por restrição parcial |
| HS | Horas equivalentes em serviço |
| HDCE | Horas desligada por condições externas |
| HRD | Horas equivalentes de reserva desligada |
| HP | Horas do período de apuração da UG |

Uma restrição de 50% durante 10 horas equivale a 5 horas indisponíveis. HP pode ser menor que as horas do mês quando a operação comercial cobre apenas parte dele. Esses critérios são descritos no mesmo Anexo 3.

O mês de referência contábil usa os 60 meses anteriores. Por exemplo, novembro de 2026 usa novembro de 2021 a outubro de 2026. O SQL diferencia `mes_referencia_contabil` de `mes_fim_historico`. Na conciliação com o arquivo público, `din_mes` é alinhado ao mês final do histórico; esse alinhamento reproduz as taxas verificadas, exceto a divergência de Jurumirim descrita abaixo.

As taxas ficam em fração de 0 a 1; as colunas terminadas em `_pct` multiplicam por 100. O [dicionário das taxas publicadas pelo ONS](https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/taxa_teif_teip/DicionarioDados_Taxa_Teifa_Teip.pdf) confirma a escala de 0 a 1.

## Filtro das UGs da CTG Brasil

A [página de operações hidrelétricas da CTG Brasil](https://www.ctgbr.com.br/operacoes/energia-hidreletrica/) apresenta as 12 UHEs operadas e duas PCHs. O cadastro explícito em `scripts/sql/01_fontes.sql` associa as UHEs aos CEGs encontrados nos dados:

| Usina | CEG | UGs no escopo |
| --- | --- | ---: |
| Canoas I | UHE.PH.SP.000647-5.01 | 3 |
| Canoas II | UHE.PH.SP.027092-0.01 | 3 |
| Capivara | UHE.PH.SP.000657-2.01 | 4 |
| Chavantes | UHE.PH.SP.000764-1.01 | 4 |
| Garibaldi | UHE.PH.SC.030415-8.01 | 3 |
| Ilha Solteira | UHE.PH.SP.001120-7.01 | 20 |
| Jupiá | UHE.PH.SP.001282-3.01 | 14 |
| Jurumirim | UHE.PH.SP.001285-8.01 | 2 |
| Rosana | UHE.PH.SP.002555-0.01 | 4 |
| Salto | UHE.PH.GO.028758-0.01 | 2 |
| Salto Grande SP | UHE.PH.SP.002648-4.01 | 4 |
| Taquaruçu | UHE.PH.SP.002821-5.01 | 5 |

A chave de junção é **CEG + número da UG**. Isso distingue, por exemplo, Salto Grande SP de Salto Grande MG e evita depender da potência arredondada ou da grafia no nome da unidade. O cadastro atual identifica `RIO PARANA ENERGIA` como operador dessas UHEs; um filtro textual por “CTG” não as selecionaria.

As tabelas de cálculo e as views com sufixo `_ctg` abrangem somente as 12 UHEs listadas acima.

Palmeiras e Retiro não constam dos Parquets de parâmetros recebidos. Garibaldi possui uma UG4 de 2,9 MW no cadastro de capacidade, ausente desses parâmetros; o escopo usa as UGs 1 a 3, que reproduzem a taxa publicada. `auditoria_ugs` expõe essa diferença de cobertura.

## Fontes e qualidade dos dados

Os sete arquivos em `dados/ons/parametros/` cobrem janeiro de 2020 a outubro de 2026. A base de [parâmetros do ONS](https://dados.ons.org.br/dataset/taxa_teif_teip_parametro) fornece as horas; a [capacidade instalada](https://dados.ons.org.br/dataset/capacidade-geracao) fornece a potência; as [taxas publicadas](https://dados.ons.org.br/dataset/taxa_teif_teip) permitem a conciliação. As fontes são públicas, de autoria do ONS, sob licença CC BY. O projeto transforma e agrega esses dados.

O SQL seleciona a versão mais recente por CEG, UG e mês. Duplicatas idênticas contam uma vez; duplicatas conflitantes invalidam o resultado. Também verifica os oito insumos, valores finitos e não negativos, potência positiva e fechamento das horas, com tolerância de 0,01 hora. Essas verificações são controles de qualidade da implementação. A única ressalva de fechamento revisada é Ilha Solteira em maio de 2021, detalhada ao final deste documento; os demais casos continuam invalidando o cálculo.

O cadastro de capacidade é um retrato atual, **sem histórico**, conforme a descrição do ONS. A tabela `potencia_ug_mensal` permite informar potências históricas comprovadas, por UG e mês; na ausência delas, usa-se o cadastro atual. Essa hipótese fica identificada em `fonte_potencia`.

Meses ausentes ou inválidos não recebem zero. O resultado de 60 meses fica `NULL` enquanto não houver 60 meses válidos. O calendário contínuo impede que uma lacuna seja compensada por um mês fora da janela.

Com os 12 meses de 2020 e a ressalva documentada de Ilha Solteira, a primeira janela completa termina em dezembro de 2024 para as 12 usinas, aplicável à referência contábil de janeiro de 2025. Os registros de 2020 também são exportados e permanecem com `HISTORICO_INCOMPLETO`, pois suas janelas exigiriam dados anteriores a 2020.

A rotina do ONS prevê complementar histórico insuficiente e meses completos de suspensão comercial com referências da garantia física convertidas em horas. A tabela `referencia_ug_mensal` aceita essas referências oficiais para meses inteiros sem parâmetros. As contribuições são `P*HP*IP` para o numerador programado, `P*HP*(1-IP)` para o denominador forçado e `P*HP*TEIF*(1-IP)` para o numerador forçado. A implementação não completa meses parcialmente observados; estes exigem tratamento dos parâmetros correspondentes. As tabelas de referência e potência são preservadas em novas execuções.

## Execução e consultas

O ponto de entrada é `scripts/executar.py`. O atalho `python executar.py` na raiz continua disponível. Na raiz do projeto, instale as dependências uma vez:

```powershell
python -m pip install -r requirements.txt
```

Para a primeira execução ou atualização mensal, baixe todas as fontes e calcule com um comando:

```powershell
python scripts/executar.py --atualizar
```

Esse modo baixa os parâmetros anuais de 2020 até o ano atual em `dados/ons/parametros/`, o cadastro de potência em `dados/ons/cadastro/`, as taxas publicadas em `dados/ons/taxas/` e as referências da garantia física em `dados/mme/`. Em seguida, executa o SQL e grava o banco, os Parquets e o HTML nas subpastas de `resultados/`. Uma falha no download interrompe o processo antes do cálculo. Um intervalo menor de download não remove arquivos de outros anos já existentes; o cálculo lê todos os Parquets em `dados/ons/parametros/`.

Para recalcular com os arquivos já disponíveis, sem acessar a internet:

```powershell
# Primeira execução ou atualização mensal: baixar tudo e calcular
python scripts/executar.py --atualizar

# Recalcular usando os arquivos locais, sem download
python scripts/executar.py

# Apenas baixar os dados, sem calcular
python scripts/executar.py --somente-baixar
```

O download, o cálculo e a exportação estão integrados em `scripts/executar.py`. O download usa a biblioteca padrão do Python, sem depender de `requests`.

Opções adicionais e testes:

```powershell
python scripts/executar.py --help
python scripts/executar.py --atualizar --ano-inicial 2020 --ano-final 2026
python -m unittest discover -s tests -v
```

Para validar o painel, a simulação e o download de cenários pelo navegador, com Playwright e Microsoft Edge instalados:

```powershell
python -m tests.validar_navegador
```

As capturas desse teste ficam em `resultados/validacoes/painel/`.

Os cálculos históricos e a gravação de cenários usam SQL. O Python executa as consultas, converte as referências e gera o painel. Em um cliente DuckDB, execute `scripts/sql/01_fontes.sql`, `scripts/sql/02_calculo.sql` e `scripts/sql/04_produtos.sql`, nessa ordem, com a raiz do projeto como diretório de trabalho. `scripts/sql/03_consultas.sql` contém exemplos. O HTML também possui um motor local de simulação, verificado contra o SQL.

```sql
-- Mensal de outubro de 2026
SELECT usina, teifa_pct, teip_pct, mes_valido
FROM taxas_mensais_ctg
WHERE mes = DATE '2026-10-01'
ORDER BY usina;

-- Acumulado aplicável à referência contábil novembro de 2026
SELECT usina, teifa_pct, teip_pct, meses_validos
FROM taxas_60_meses_ctg
WHERE mes_referencia_contabil = DATE '2026-11-01'
ORDER BY usina;

-- Conferir diferenças em relação ao publicado
SELECT * FROM conciliacao_ons
WHERE mes_fim_historico = DATE '2026-10-01'
  AND status <> 'OK';
```

## Aplicação Web CTG Brasil (6 Páginas)

### Deploy no Railway

Conecte o repositório a um serviço Railway, monte um volume persistente em `/data` e defina `CALC_ID_WEB_PASSWORD` e `CALC_ID_ADMIN_PASSWORD` nas variáveis do serviço. Na tela de entrada, a conta inicial é `painel` e usa `CALC_ID_WEB_PASSWORD`. A área Administrador pede a senha administrativa separadamente. O serviço usa a porta `PORT` e o Railway testa `/api/health`.

Em **Administrador → Usuários**, é possível criar contas individuais, editar nomes, trocar senhas e ativar ou desativar acessos. Trocar a senha ou desativar uma conta encerra suas sessões abertas. As contas ficam em `/data/dados/usuarios.sqlite3`. A senha da conta inicial é alterada nas variáveis do Railway.

O primeiro deploy copia as bases públicas do ONS e do MME para o volume. Os deploys seguintes conservam os insumos atualizados, as configurações do painel, os arquivos carregados e os cenários. O serviço recalcula os produtos na inicialização. A planilha de manutenções pode ser carregada na área Administrador e o cadastro SIN pode ser colocado em `/data/dados/referencias_sin/` pelo acesso autenticado ao volume. Rode **Recalcular** após adicionar os insumos.

### Execução local

Para abrir a aplicação completa (com servidor local para gravação de cenários Parquet, upload de planilhas, execução de scripts e explorador SQL/Parquet):

```powershell
python scripts/executar.py --painel
```

Acesse `http://127.0.0.1:8765` (o navegador abre automaticamente). A navegação contempla 6 páginas:

1. **Visão Geral**: acompanhamento da situação atual das 12 UHEs (filtrável por Polo, Usina e Mês apurado), gráficos interativos (ID %, FID Bruto, TEIFa × TEIP), tabela consolidada e horas apuradas por UG.
2. **Simulador FID (60 meses)**: projeção mensal na janela móvel de 60 meses do ONS já **pré-carregada com as paradas programadas** do plano plurianual (HDP por UG/mês), comparando 3 trajetórias (Sem paradas × Plano Plurianual × Cenário Simulado), calculadora de **Margem de Segurança (Headroom FID ≥ 1)**, ferramenta rápida de teste de estresse (HDF/HDP) e gravação de cenários em Parquet.
3. **Paradas Programadas**: cronograma plurianual da planilha `dados/manutencoes/Manutencoes_e_Modernizacoes_CTG_Brasil_Plurianual.xlsm` com KPIs, gráficos mensais/por usina, **cronograma Gantt interativo por UG** e tabela pesquisável com regras oficiais de retorno diário (12h), expurgo ONS, rateio de virada de mês e deduplicação de sobreposições.
4. **Projeção 2028 (SIN)**: revisão quinquenal de referências por 5 faixas de potência unitária (MW/UG) calculada sobre a base ONS mais recente, com controles de sensibilidade (Fator TEIFa, Fator TEIP, exclusão de Pimental/Belo Monte, inclusão de Itaipu), comparação das 12 UHEs CTG por Polo (ID Atual × ID Projetado +24m com paradas × Faixa 2028) e validação cruzada 2022.
5. **Metodologia & ONS**: fórmulas oficiais (`RO-AO.BR.04 Rev. 47`, `REN ANEEL 1.033/2022`, `Portaria MME 709/2022`), glossário de estados operativos, conciliação ONS e auditoria de fechamento de horas.
6. **Administrador (protegido por senha)**:
   - **Senha inicial padrão**: `ctg@admin2026` (pode ser alterada na sub-aba *Segurança* ou sobrescrita pela variável de ambiente `CALC_ID_ADMIN_PASSWORD`).
   - **Atualizar Dados & Scripts**: roda o pipeline local ou baixa novos Parquets do ONS/MME com log ao vivo no terminal web e recarrega a interface automaticamente.
   - **Manutenções (Excel / Banco)**: upload direto de novas versões da planilha plurianual (`.xlsm`/`.xlsx`) e configuração preparada para conectar futuramente a uma tabela de banco de dados externo (PostgreSQL, SQL Server, DuckDB ou SQLite) em `dados/config_fontes.json`.
   - **Explorador Parquet & Console SQL (DuckDB)**: inspeção de esquema, filtro, paginação e download de todos os Parquets de `dados/` e `resultados/`, além de console SQL somente leitura com exportação para CSV.

## Parquets e painel de cenários

O arquivo `resultados/intermediarias/horas_ug_mensal_ctg.parquet` tem uma linha por UG e mês, com `data`, `cod_ceg`, `nome_usina`, `ug`, `nome_ug`, `potencia_ug_mw`, `HDP`, `HDF`, `HEDP`, `HEDF`, `HS`, `HRD`, `HDCE` e `HP`. Também inclui versão, origem da potência e flags de qualidade. As horas observadas são preservadas, inclusive quando o fechamento é inválido. A coluna `valido` indica elegibilidade para o cálculo, incluindo a ressalva documentada; para exigir fechamento consistente, filtre também `horas_validas`. As colunas `saldo_horas`, `ressalva_fechamento`, `motivo_ressalva` e `fonte_ressalva` permitem auditar o caso. Os 82 meses atuais produzem 5.576 linhas.

| Caminho relativo a `resultados/` | Conteúdo |
| --- | --- |
| `consolidadas/indicadores_disponibilidade_ctg.parquet` | Tabela consolidada principal: TEIFa, TEIP, ID verificado, referência e FID |
| `consolidadas/taxas_mensais_ctg.parquet` | Taxas do mês isolado |
| `consolidadas/taxas_60_meses_ctg.parquet` | Taxas na janela móvel de 60 meses |
| `intermediarias/horas_ug_mensal_ctg.parquet` | Horas, potência e qualidade por UG e mês |
| `intermediarias/referencias_fid_ctg.parquet` | TEIF e IP de referência por usina, vigência e fonte |
| `intermediarias/parcelas_usina_mensal_ctg.parquet` | Numeradores e denominadores mensais para recompor janelas |
| `validacoes/conciliacao_ons.parquet` | Comparação com taxas publicadas |
| `validacoes/auditoria_ugs.parquet` | Cobertura do cadastro de UGs |
| `validacoes/auditoria_parametros.parquet` | Parâmetros com chave inválida ou fora do escopo |
| `validacoes/auditoria_fechamento_horas.parquet` | UGs com fechamento inconsistente, saldo e eventual ressalva |
| `banco/indicadores.duckdb` | Banco com tabelas de cálculo e configurações preservadas |
| `painel/painel.html` | Painel autocontido para consulta e simulação |

Para gerar os arquivos e abrir o painel com gravação de cenários:

```powershell
python scripts/executar.py --painel
```

Para atualizar as fontes antes de abrir:

```powershell
python scripts/executar.py --atualizar --painel
```

A aba **Cenário atual** filtra por usina e mês e mostra os índices, a conciliação e as horas de cada UG. A aba **Simular indisponibilidades** permite escolher uma usina, projetar de 1 a 120 meses e informar as horas de cada UG em cada mês. Nos meses não editados, a hipótese é disponibilidade total; a potência permanece igual à do mês base. HS é calculado pelo saldo das horas do mês. Valores negativos ou soma superior a HP impedem o cálculo.

A simulação soma as parcelas históricas e projetadas dentro de cada janela de 60 meses. Por exemplo, ao projetar novembro/2026, entra novembro/2026 e sai novembro/2021; a janela passa a dezembro/2021–novembro/2026. O índice dessa janela aplica-se à referência contábil dezembro/2026. Após 60 meses projetados, nenhum mês do histórico original permanece na janela.

**Salvar cenário em Parquet** revalida os dados e recalcula no DuckDB, gravando dois Parquets em `resultados/cenarios/`: as horas futuras por UG e os índices projetados. Os links no painel permitem baixar os arquivos. As hipóteses não alteram o histórico real. As edições também ficam no armazenamento local do navegador, por usina e mês base.

O HTML é autocontido: `resultados/painel/painel.html` pode ser aberto diretamente para consultar e simular sem servidor ou internet. Para gravar e baixar cenários Parquet, use `--painel` e mantenha o terminal aberto. `Ctrl+C` encerra o servidor, restrito a `127.0.0.1`. Não são produzidos arquivos JSON ou CSV; o HTML incorpora os dados necessários à exibição.

## Referências da garantia física e FID

As taxas **apuradas** do ONS são mensais. Os índices **de referência** têm outra origem: a [Portaria Normativa MME 42/2022](https://www.gov.br/mme/pt-br/acesso-a-informacao/legislacao/portarias/2022/portaria-normativa-n-42-gm-mme-2022.pdf/) prevê atualização quinquenal da tabela por faixas de potência no art. 7º e atualização anual dos valores apurados para os estudos no art. 8º.

A revisão geral de referência localizada para as usinas deste projeto é a [Portaria MME 709/2022](https://www.gov.br/mme/pt-br/acesso-a-informacao/legislacao/portarias/2022/portaria-n-709-gm-mme-2022.pdf/@@download/file), com vigência a partir de janeiro de 2023. O projeto utiliza as taxas específicas de cada CEG desse anexo, inclusive as de Jupiá, em vez de substituir todas as usinas pela tabela genérica de faixas. Revisões extraordinárias ou atos posteriores podem exigir referências diferentes.

A fonte oficial encontrada é um PDF. A atualização baixa esse documento em memória e converte a tabela para `dados/mme/REFERENCIAS_FID.parquet`, incluindo URL, vigência, hash do documento e data de consulta. O cálculo exige uma referência única para cada uma das 12 UHEs. O script consulta novamente essa fonte a cada `--atualizar`; a descoberta de uma nova portaria não é automática. Para incorporar outro ato validado, indique sua URL:

```powershell
python scripts/executar.py --atualizar --referencias-url "URL_OFICIAL_DO_NOVO_DOCUMENTO"
```

O extrator exige uma tabela com CEG, TEIF e IP e uma vigência reconhecida. Uma fonte Parquet pode ser usada se tiver o mesmo esquema de `dados/mme/REFERENCIAS_FID.parquet`. A URL indicada fica registrada no próprio Parquet e é reutilizada nas atualizações seguintes, sem voltar à fonte de 2022. Um erro de leitura não substitui o arquivo anterior.

```text
ID verificado = (1 − TEIFa acumulada) × (1 − TEIP acumulada)
ID referência = (1 − TEIF referência) × (1 − IP referência)
FID bruto     = ID verificado / ID referência
FID MRA       = mínimo(1, FID bruto)
```

A limitação do fator no MRA consta da regulamentação consolidada na [REN ANEEL 1.033/2022](https://www2.aneel.gov.br/cedoc/ren20221033.pdf). O painel mostra também o quociente bruto para acompanhar a margem acima de 1. Alterar o ID de referência no simulador é uma hipótese do cenário e não muda o cadastro oficial. A referência vigente é mantida nas projeções futuras, até que uma nova publicação seja incorporada.

## Validação com os arquivos de novembro de 2026

Os testes verificam ponderação por potência, limites da janela, lacunas mensais, UG ausente, revisão parcial, duplicatas, referências, denominador zero e projeção de meses futuros. Para os testes dos produtos de dados, execute `python scripts/executar.py` antes da suíte.

No histórico encerrado em outubro de 2026, 22 das 24 taxas das UHEs operadas coincidem com o publicado, dentro de 0,0000000051 em fração, tolerância compatível com oito casas decimais.

| Jurumirim em outubro de 2026 | Calculada em % | Publicada em % | Diferença em pontos percentuais |
| --- | ---: | ---: | ---: |
| TEIFa | 0,239929010 | 0,236445000 | 0,003484010 |
| TEIP | 1,438500213 | 1,438286000 | 0,000214213 |

A divergência de Jurumirim permanece após a inclusão do arquivo de 2020 em 25/11/2026. Sua causa exige conciliar parâmetros, critérios e cadastro histórico com o ONS. O cálculo não aplica ajustes para forçar igualdade.

Em Ilha Solteira, maio de 2021 apresenta diferenças entre HP e a soma das demais horas nas UGs 5 a 10 e 14 a 20. O saldo total é 4.638,9 horas, somadas entre as 13 UGs. Por exemplo, a UG9 tem HP=744 horas e todos os demais insumos zerados. Em 25/11/2026, o Parquet público de 2021 foi baixado novamente e conferido como idêntico ao local (SHA-256 `de1dbdc7a567cd6abd9c7b906cc35f9e95841a27d39b3068dabc5707cb083275`); o CSV oficial confirma os valores. A classificação dessas horas não pode ser determinada por esses arquivos.

Usando os oito parâmetros originais, as 34 taxas das 17 janelas encerradas entre dezembro de 2024 e abril de 2026 conciliam com o ONS. Atribuir o saldo a HRD, HS ou HDCE aumentaria o denominador da TEIFa e provocaria divergência. Por isso, o tratamento adotado é uma ressalva local de qualidade, sem alterar os parâmetros nem preencher horas. Essa conciliação confirma a reprodução das taxas publicadas, não a completude dos estados operativos da fonte.

`ressalvas_fechamento_ons`, em `scripts/sql/01_fontes.sql`, registra os valores exatos das 13 UGs revisadas. A ressalva exige a mesma usina, mês, UG, versão e os mesmos oito parâmetros, além dos controles de integridade dos insumos e HP. Mudanças nesses valores desativam a ressalva e passam pelo controle normal. `horas_validas` permanece falso nessas 13 linhas, `ressalva_fechamento` é verdadeiro e `valido` permite o cálculo. Nas taxas acumuladas e na conciliação, `meses_com_ressalva` identifica as janelas afetadas. O painel exibe o saldo por UG e os avisos de qualidade.

Maio de 2021 passa a contar para o cálculo mensal e para as janelas de Ilha Solteira, cuja primeira janela completa termina em dezembro de 2024. A janela mais recente começa em novembro de 2021 e não utiliza a ressalva.
