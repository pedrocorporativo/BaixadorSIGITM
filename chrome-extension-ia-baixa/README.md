# Baixador Automático v2

Extensão independente em Manifest V3 para leitura e baixa controlada de chamados no SIGITM. A pasta foi criada separadamente do dashboard e da extensão anterior.

## Arquitetura

- `ai/`: serviço/provedor Gemini e schema estruturado da resposta.
- `rules/`: normalização fechada e motor determinístico, seguido de comparação IA × regras.
- `content/` e `automation/`: leitura com cliques nas abas, validação de datas/acionamento, preenchimento e confirmação.
- `background/`: coordena IA, valida remetentes, modo de execução, parada e histórico.
- `storage/`: configurações e histórico local.
- `popup/`: chamado atual, decisão, modo análise/automático e botão **PARAR AUTOMAÇÃO**.
- `options/`: configuração da IA, histórico e exportação CSV.

## Provedor gratuito escolhido

Há dois adaptadores: **Google Gemini Developer API** (`gemini-3.8-flash`) e **Groq Cloud** (`openai/gpt-oss-120b`). Groq é a alternativa rápida com free tier/limites publicados, sujeitos a mudanças e disponibilidade da conta; confira os [modelos Groq](https://console.groq.com/docs/models) e [rate limits](https://console.groq.com/docs/rate-limits). A API de chat do Groq usa formato compatível com OpenAI e modo de resposta JSON; o código ainda valida o schema localmente. O Gemini mantém JSON estruturado conforme a [documentação oficial](https://ai.google.dev/gemini-api/docs/structured-output) e tem entrada/saída gratuitas nos modelos e condições indicados pela [página oficial de preços](https://ai.google.dev/gemini-api/docs/pricing).

**Aviso de privacidade:** no nível gratuito, o Google informa que o conteúdo pode ser usado para melhorar produtos. Use somente se a política da sua organização permitir. O pedido contém apenas Tipo de Abertura, Procedência, Tipo de Incidência, Cliente, Intragov e Serviço Afetado; não envia número do chamado, datas, HTML, cookies, tokens ou senhas. Sem chave ou com falha da API, o motor determinístico pode operar como fallback quando os campos permitirem. Divergência entre IA e regras bloqueia a execução.

O adaptador fica separado em `ai/ai-provider.js`; as chaves Gemini e Groq são armazenadas separadamente e nunca gravadas no código. Para Groq, gere uma chave em [Groq Console](https://console.groq.com/keys). A chave fica em `chrome.storage.local` do perfil local, sem sincronização pelo Chrome; não é criptografada por esta extensão. Para distribuição pública ou ambiente multiusuário, prefira um backend intermediário com autenticação e cofre de segredos.

## Regras implementadas

1. Cliente cujo nome contenha `SECRETARIA DE EDUCAÇÃO` ou `FUNDO PARA O DESENVOLVIMENTO DA EDUCAÇÃO` (incluindo prefixos como `SEDUC -` e `FED -`) → `2A011`, independente dos outros campos e sem pergunta.
2. Tipo de Incidência DDR → `57033`, independente dos outros campos, exceto a prioridade SEDUC acima.
3. Intragov marcado + Serviço Afetado `SAI - Serviço de Acesso à Internet` → `6Y200`.
4. Tipo de Abertura Repetido (7/30 dias ou valor genérico) + Procedência Proativo → `2A082`.
5. Inicial + Preventivo/Reativo/Proativo ou Repetido + Reativo → `2A011`, sem restrição de cliente.
6. Todos os serviços, inclusive SAI, usam o diagnóstico `00000017 Testado OK`. Prioridade: SEDUC, DDR, Intragov + SAI, Repetido + Proativo, depois as combinações restantes de 2A011.

No modo automático, para clientes diferentes de SEDUC, a página SIGITM pergunta qual código utilizar na primeira vez de cada combinação dos campos de abertura, procedência, incidência, Intragov e serviço. O nome dos clientes não SEDUC não separa a aprendizagem: a mesma escolha é reutilizada entre esses clientes quando os outros campos são iguais. A escolha fica em `chrome.storage.local`. Cancelar a pergunta interrompe a execução antes de qualquer ação no chamado. O histórico registra a origem do código escolhido.

A IA não define códigos livres: sua decisão, diagnóstico e campos normalizados são validados contra enums e comparados ao motor independente. Saídas malformadas/IA indisponível podem usar fallback determinístico; uma resposta válida divergente bloqueia. A leitura das abas de classificação usa espera curta para avançar assim que os campos forem coletados.
O modelo de IA recebe somente a tarefa de classificar os campos e devolver o código/diagnóstico estruturados; ele não enxerga nem clica na interface. Os cliques em Bloquear, X do popup, Baixar, guias, código e lupa são executados pela automação da extensão. Após validar regras/datas, a sequência Bloquear → fechar popup → aguardar Cliente e botão Baixar → clicar Baixar ocorre antes do preenchimento de Diagnóstico e Encerramento. Há espera de 5 s ao abrir Cliente e até 10 s para o botão Baixar aparecer; depois, uma espera adicional de 3,5 s após fechar o popup de Baixar permite a atualização do SIGITM. Janelas de pesquisa são aguardadas somente até aparecerem.

## Instalação e configuração

1. Em `chrome://extensions`, ative **Modo do desenvolvedor**.
2. Clique **Carregar sem compactação** e selecione a pasta `chrome-extension-ia-baixa`.
3. Abra um chamado no SIGITM e atualize a página após instalar a extensão.
4. No popup, use **Analisar somente** para consultar sem alterar o chamado. Para executar o fluxo completo, use **Baixar automaticamente** e confirme a autorização. Em um chamado, processa esse chamado; em uma lista compatível, detecta a tabela e inicia a fila sequencial.
5. Para IA, abra **Configurações de IA e histórico**, escolha Gemini ou Groq, gere a chave no [Google AI Studio](https://aistudio.google.com/apikey) ou [Groq Console](https://console.groq.com/keys), cole no campo de senha, aceite o aviso de privacidade e salve. As credenciais dos dois provedores não são compartilhadas.
	“Chave salva” confirma apenas o armazenamento. Clique em **Testar conexão Gemini/Groq**: o teste envia um caso sintético fixo, sem ticket ou dados reais, e valida o retorno JSON.
6. Teste todas as regras em ambiente autorizado. Só então altere para **Modo automático**. O popup pede confirmação adicional para ativar esse modo.
7. Use **PARAR AUTOMAÇÃO** para abortar uma chamada ativa e impedir ações seguintes; o último resultado permanece disponível.

A extensão processa em lote quando **Baixar automaticamente** é acionado numa lista SIGITM compatível. Detecta `idConsulta` (138550 = Ativos e Parados; 95803 = Validação Massiva), clica na sequência da coluna **Seq** (dá um segundo clique se o primeiro só selecionar a linha), e processa um ticket por vez. Fecha a guia do ticket somente depois de confirmar “Ticket liberado”; depois volta à tabela até encontrar zero registros. Chamados que falham antes de acionar Gravar Baixa são registrados e pulados. Se Gravar Baixa foi acionado, mas a confirmação não apareceu, a fila pausa e mantém a guia aberta para conferência. O processamento requer a permissão de guias do Chrome.
Na execução de lote, a extensão não usa uma pausa fixa entre cliques: segue assim que o controle estiver disponível e aguarda somente enquanto detecta a tela/indicador de carregamento. O indicador é reconhecido por elementos de loading comuns ou por um overlay central com ícone animado.

Na execução individual, a extensão atua somente na aba SIGITM atual.
Se a página estiver aberta desde antes da instalação/reload, ao iniciar a análise o background tenta reinjetar os scripts na guia SIGITM atual. Um novo clique em **Analisar chamado atual** na mesma guia substitui uma execução antiga que ficou presa; para mudar de guia com uma execução ativa, use **PARAR AUTOMAÇÃO** primeiro. Após atualizar a extensão, atualize também a página SIGITM para remover listeners da versão anterior.

## Regras de segurança / requisitos do SIGITM

- Valores de formulário são localizados por rótulos visíveis, inclusive nas estruturas legadas de linha/célula do SIGITM. Para **Data de Reparo**, também são aceitas as variações `Data Reparo`, `Data do Reparo` e `Dt. Reparo`. Controles somente leitura/desabilitados são deixados intactos e registrados; campo ausente ou ambíguo ainda bloqueia para evitar preencher o campo errado.
- Na aba **Encerramento**, o campo do código aceita as variações `Código Completo da Baixa`, `Código Completo Baixa`, `Código da Baixa` e `Código Baixa`; após abrir a aba, a extensão aguarda até 7 segundos pelo campo antes de registrar uma falha.
- Após preencher e conferir os campos de Encerramento, a automação aciona **Gravar Baixa** automaticamente. A execução ainda exige que todas as regras e validações passem; falhas interrompem o fluxo antes do clique final.
- A extensão não clica no controle “X/Fechar” do pop-up de resultado; lê o texto do pop-up para identificar sucesso ou recusa e o mantém aberto.
- Se a baixa falhar ou não for confirmada pelo SIGITM, a execução termina e qualquer próxima execução enfileirada é descartada.
- Acionamento ativo 6Z036 é baixado separadamente (Responsável/Descrição `xx`) e o chamado é relido antes da baixa principal.
- A **Data de Reparo** no Encerramento nunca copia a Data de Reparo existente na aba Data: ela usa **Data Criação + 1 hora**. Com **Pausa de Relógio ativa**, ela obrigatoriamente fica anterior ao início da pausa; se o cálculo cair na pausa, a extensão usa o último minuto antes dela. A baixa só prossegue se a data ficar no intervalo válido: posterior à Data Criação e anterior à Data Objetivo, respeitando o SLA de 4 horas.
- No Encerramento, **Descrição**, **Técnico**, **Área Técnica**, **Responsável** e os dois campos Telefone recebem `xx`. Intragov é lido somente na aba **Definição**: se estiver marcado, o primeiro Telefone passa a ter duas caixas, preenchidas com `00` (DDD) e `000000000`; o segundo Telefone recebe `xx`. Os Telefones históricos brancos não são alterados. Se o checkbox Intragov não estiver presente, a extensão o interpreta como desmarcado e usa os dois Telefones comuns com `xx`. Na guia Acionamento, Responsável e Descrição recebem `xx`.
- No fluxo automático, a extensão clica em **Bloquear**, fecha somente o popup informativo identificado, clica uma vez em **Baixar** e fecha pelo **X** o popup informativo que surgir. Só então abre **Definição**, preenche o **Diagnóstico** com `00000017 Testado OK`, clica na lupa ao lado do campo e seleciona esse código. Depois, acessa **Encerramento**, deixa **Serviço Afetado** como está, preenche e confirma a **Data de Reparo**, e preenche/verifica os demais campos. Após as validações, clica automaticamente em **Gravar Baixa**. Nos casos de Intragov, mantém o preenchimento específico dos campos Intragov e telefone. As trocas de aba e pesquisas aguardam o carregamento do SIGITM antes do próximo clique; erros ou controles ambíguos interrompem a sequência.
- Após a confirmação visual **Ticket liberado**, a extensão fecha a guia do BD, volta para a consulta **Validação Massiva** (`idConsulta=95803`), clica em **Atualizar** e abre o próximo BD pela coluna **Seq**. Isso ocorre tanto ao iniciar diretamente pela lista como quando a automação tiver começado em um BD individual.
- Se o X do popup for um link `javascript:` bloqueado pela CSP, a extensão cancela a navegação bloqueada, permite handlers normais de clique e tenta somente uma função de fechamento simples já exposta pela janela; não avalia código arbitrário.
- A extensão não foi testada contra o HTML autenticado real do SIGITM. Confirme os rótulos/abas e textos de sucesso em homologação; qualquer divergência resulta em interrupção ou erro, não em clique presumido.
- O modo automático fica desligado por padrão. Um stop aborta requisições e próximos passos, embora um clique já recebido pelo SIGITM não possa ser desfeito.

Se Groq responder `json_validate_failed` / “Failed to generate JSON”, recarregue a extensão e teste novamente. O adaptador agora instrui explicitamente `json` nos papéis system e user, condição exigida pelo modo JSON do endpoint. Se o modelo continuar falhando, escolha outro modelo Groq disponível na conta; o motor local ainda bloqueia decisões inválidas e pode usar fallback determinístico.

## Histórico e processamento em lote

O histórico dos últimos 500 resultados fica localmente e pode ser exportado como CSV na tela de opções. `automation/queue.js` oferece a base sequencial para lote futuro, com falha isolada por item; a interface atual processa somente o chamado aberto e não inicia lotes automaticamente.

## Testes

Com Node.js instalado, execute `npm test` na raiz do projeto. Os testes cobrem os sete casos solicitados, prioridade DDR, divergência IA/regras, schema, privacidade do payload, datas/SLA, fallback, fila e manifesto.
