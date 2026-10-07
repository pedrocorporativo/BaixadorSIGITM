"use strict";

const $ = id => document.getElementById(id);

function friendlyError(error) {
  const message = String(error?.message || error || "Falha desconhecida.");
  if (/could not establish connection|receiving end does not exist/i.test(message)) {
    return "A extensão ainda não conectou à página. Recarregue a extensão em chrome://extensions e depois atualize a página do SIGITM.";
  }
  return message;
}

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Falha de comunicação."));
    else resolve(response);
  }));
}

function renderState(state) {
  const result = state.current;
  $("mode").value = state.mode || "analysis";
  $("modeHint").textContent = state.mode === "automatic"
    ? "Preenche e grava o chamado atual; se estiver em uma lista SIGITM, processa um ticket por vez. Use PARAR a qualquer momento."
    : "Lê os campos e mostra o código recomendado; não altera o chamado.";
  const stopButton = $("stop");
  if (state.stopped) {
    stopButton.disabled = true;
    stopButton.dataset.state = "paused";
    stopButton.innerHTML = '<span aria-hidden="true">Ⅱ</span> Automação pausada';
  } else if (state.automationActive) {
    stopButton.disabled = false;
    stopButton.dataset.state = "active";
    stopButton.innerHTML = '<span aria-hidden="true">Ⅱ</span> Pausar automação';
  } else {
    stopButton.disabled = true;
    stopButton.dataset.state = "idle";
    stopButton.innerHTML = '<span aria-hidden="true">■</span> Automação inativa';
  }
  const connection = state.aiConnection;
  const sameProviderTest = connection?.providerId === state.provider;
  if (!state.aiConfigured) {
    $("aiStatus").dataset.state = "fallback";
    $("aiStatusTitle").textContent = "Sem conexão — regras locais ativas";
    $("aiStatusText").textContent = `A IA não é necessária para baixar: as regras locais continuam classificando os chamados. Sem chave ${state.provider}, não há conferência online.`;
  } else if (sameProviderTest && connection.connected) {
    $("aiStatus").dataset.state = "ready";
    $("aiStatusTitle").textContent = `Conectada — validação adicional ativa (${connection.provider})`;
    const testedAt = connection.testedAt ? new Date(connection.testedAt).toLocaleString() : "";
    $("aiStatusText").textContent = `${connection.model || "Modelo configurado"} · teste aprovado. A IA confere as regras locais; se houver divergência, a baixa é bloqueada.${testedAt ? ` Testada: ${testedAt}.` : ""}`;
  } else if (sameProviderTest && connection.connected === false) {
    $("aiStatus").dataset.state = "error";
    $("aiStatusTitle").textContent = `IA indisponível — regras locais continuam ativas`;
    $("aiStatusText").textContent = `${connection.message || "O último teste da IA falhou."} A IA é opcional; se a consulta falhar, as regras locais são usadas. Uma divergência válida continua bloqueando a baixa.`;
  } else {
    $("aiStatus").dataset.state = "saved";
    $("aiStatusTitle").textContent = `Chave salva — conexão ainda não testada (${state.provider})`;
    $("aiStatusText").textContent = "A extensão tentará usar a IA e recorrerá às regras locais se ela falhar. Se a IA responder com uma classificação divergente, a baixa será bloqueada.";
  }
  if (!result) return;
  $("result").dataset.state = result.allowed ? "ready" : "blocked";
  $("resultTitle").textContent = result.executionResult || (result.allowed ? `${result.codigoBaixa} · ${result.validation?.status || "Validado"}` : (result.validation?.status || "Bloqueado"));
  const lines = [
    `Chamado: ${result.caseData?.numeroChamado || "não identificado"}`,
    `Tipo de Abertura: ${result.caseData?.tipoAbertura || "não identificado"}`,
    `Procedência: ${result.caseData?.procedencia || "não identificada"}`,
    `Tipo de Incidência: ${result.caseData?.tipoIncidencia || "não identificada"}`,
    `Cliente: ${result.caseData?.cliente || "não identificado"}`,
    `Intragov: ${result.caseData?.intragov || "não identificado"}`,
    `Serviço Afetado: ${result.caseData?.servicoAfetado || "não identificado"}`,
    `Data Criação: ${result.caseData?.dataCriacao || "não identificada"}`,
    `Data de Reparo: ${result.caseData?.dataReparo || "não identificada"}`,
    `Início do SLA: ${result.caseData?.dataInicioSla || "não identificado"}`,
    `Data Objetivo: ${result.caseData?.dataObjetivo || "não identificada"}`,
    `Pausa de Relógio: ${result.caseData?.paradaRelogio || "não identificada"}`,
    `Acionamento: ${result.caseData?.codigoAcionamento || result.caseData?.acionamento || "não identificado"}`,
    `Diagnóstico: ${result.diagnostico || "—"}`,
    `Origem do código: ${result.codeSelection?.source || "regras locais"}`,
    `Motivo: ${result.motivo || result.validation?.reason || "—"}`,
    `Confiança IA: ${result.ai?.confidence == null ? "indisponível" : `${Math.round(result.ai.confidence * 100)}%`}`,
    `Validação: ${result.validation?.reason || result.validation?.status || "—"}`
  ];
  $("resultSummary").textContent = lines.join("\n");
}

async function refresh() {
  try { renderState(await send({ type: "GET_EXTENSION_STATE" })); }
  catch (error) { $("resultTitle").textContent = "Extensão desconectada"; $("resultSummary").textContent = friendlyError(error); }
}

$("mode").addEventListener("change", async event => {
  const mode = event.target.value;
  if (mode === "automatic" && !confirm("O modo automático preencherá e acionará Gravar Baixa após todas as validações. Deseja ativá-lo?")) {
    event.target.value = "analysis";
    return;
  }
  try {
    const options = await send({ type: "GET_OPTIONS" });
    await send({ type: "SAVE_OPTIONS", settings: { ...options.settings, mode } });
    await refresh();
  } catch (error) { $("resultSummary").textContent = friendlyError(error); }
});

async function startRun(mode) {
  const button = mode === "automatic" ? $("execute") : $("analyze");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = mode === "automatic" ? "Iniciando fluxo…" : "Iniciando análise…";
  try {
    const options = await send({ type: "GET_OPTIONS" });
    await send({ type: "SAVE_OPTIONS", settings: { ...options.settings, mode } });
    await send({ type: "RUN_ACTIVE_TAB" });
    window.close();
  } catch (error) {
    $("resultTitle").textContent = "Não foi possível iniciar";
    $("resultSummary").textContent = friendlyError(error);
    button.disabled = false;
    button.textContent = originalText;
  }
}

$("execute").addEventListener("click", async () => {
  const approved = confirm("Executar a baixa automática? Em uma tela de chamado, processará esse chamado. Em uma tabela SIGITM, abrirá e processará os tickets da coluna Seq um por vez até a lista ficar vazia. A fila só fecha um ticket após confirmar “Ticket liberado”.");
  if (approved) await startRun("automatic");
});

$("analyze").addEventListener("click", () => startRun("analysis"));

$("stop").addEventListener("click", async () => {
  try {
    $("stop").disabled = true;
    $("stop").textContent = "Pausando…";
    await send({ type: "STOP_AUTOMATION" });
    await refresh();
    $("resultTitle").textContent = "Automação pausada";
    $("resultSummary").textContent = "A execução atual foi interrompida e nenhuma próxima ação será iniciada. Para rodar novamente, clique em Baixar automaticamente.";
  }
  catch (error) { $("resultTitle").textContent = "Não foi possível parar"; $("resultSummary").textContent = friendlyError(error); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.baixaCurrentResult || changes.baixaSettings || changes.baixaStopRequested || changes.baixaAiConnectionStatus || changes.baixaBatchRun || changes.baixaActiveRun)) void refresh();
});
void refresh();
