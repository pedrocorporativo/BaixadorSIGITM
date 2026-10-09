"use strict";

const $ = id => document.getElementById(id);
let hasSavedKey = false;
let allHistory = [];

function setHistory(history) {
  allHistory = Array.isArray(history) ? history : [];
  renderStats(allHistory);
  const select = $("historyResult");
  const current = select.value;
  const results = [...new Set(allHistory.map(item => String(item.resultado || "")).filter(Boolean))].sort();
  select.replaceChildren(new Option("Todos os resultados", ""), ...results.map(value => new Option(value, value)));
  select.value = results.includes(current) ? current : "";
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const filtered = BaixaHelpers.filterHistory(allHistory, { text: $("historySearch").value, result: $("historyResult").value });
  renderHistory(filtered);
  $("historyCount").textContent = `${filtered.length} de ${allHistory.length}`;
}

function statCard(label, value, className = "") {
  const card = document.createElement("div");
  card.className = `stat ${className}`.trim();
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = label;
  card.append(strong, span);
  return card;
}

function renderStats(history) {
  const summary = BaixaHelpers.summarizeHistory(history);
  const grid = $("statsGrid");
  grid.replaceChildren(
    statCard("Execuções registradas", String(summary.total)),
    statCard("Baixas concluídas", String(summary.success), "ok"),
    statCard("Falhas / bloqueios", String(summary.failed), summary.failed ? "bad" : ""),
    statCard("Taxa de sucesso", summary.total ? `${Math.round(summary.successRate * 100)}%` : "—")
  );
  const codes = Object.entries(summary.byCode).sort((a, b) => b[1] - a[1]);
  if (codes.length) {
    const card = statCard("Baixas por código", "");
    card.querySelector("strong").remove();
    const list = document.createElement("ul");
    codes.forEach(([code, count]) => { const item = document.createElement("li"); item.textContent = `${code}: ${count}`; list.appendChild(item); });
    card.appendChild(list);
    grid.appendChild(card);
  }
  const days = Object.entries(summary.byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 5);
  if (days.length) {
    const card = statCard("Últimos dias com baixas", "");
    card.querySelector("strong").remove();
    const list = document.createElement("ul");
    days.forEach(([day, count]) => { const item = document.createElement("li"); item.textContent = `${day.split("-").reverse().join("/")}: ${count}`; list.appendChild(item); });
    card.appendChild(list);
    grid.appendChild(card);
  }
}

function renderLearning(entries) {
  const body = $("learningBody");
  body.replaceChildren();
  if (!entries.length) {
    const row = document.createElement("tr");
    const empty = cell("Nenhuma escolha aprendida.");
    empty.colSpan = 9;
    empty.className = "empty";
    row.appendChild(empty);
    body.appendChild(row);
    return;
  }
  for (const entry of entries) {
    const info = BaixaHelpers.describeLearningKey(entry.key) || {};
    const row = document.createElement("tr");
    [entry.codigoBaixa, info.tipoAbertura, info.procedencia, info.tipoIncidencia, info.intragov, info.servicoAfetado, entry.ocorrencias,
      entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : ""].forEach(value => row.appendChild(cell(value)));
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary subtle delete-learning";
    remove.textContent = "Remover";
    remove.addEventListener("click", async () => {
      try { await send({ type: "DELETE_LEARNING", key: entry.key }); await loadLearning(); }
      catch (error) { $("saveStatus").textContent = error.message; }
    });
    actions.appendChild(remove);
    row.appendChild(actions);
    body.appendChild(row);
  }
}

let learningEntries = [];
async function loadLearning() {
  learningEntries = (await send({ type: "LIST_LEARNING" })).entries || [];
  renderLearning(learningEntries);
}

function downloadJson(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

$("historySearch").addEventListener("input", applyHistoryFilter);
$("historyResult").addEventListener("change", applyHistoryFilter);

$("exportLearning").addEventListener("click", () => {
  downloadJson(`codigos-aprendidos-${new Date().toISOString().slice(0, 10)}.json`, { versao: 1, entries: learningEntries });
});
$("importLearning").addEventListener("click", () => $("importLearningFile").click());
$("importLearningFile").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("Arquivo de backup grande demais.");
    const data = JSON.parse(await file.text());
    const result = await send({ type: "IMPORT_LEARNING", entries: Array.isArray(data) ? data : data?.entries });
    $("saveStatus").textContent = `Backup importado: ${result.imported} código(s) novo(s)/atualizado(s), ${result.ignored} ignorado(s).`;
    await loadLearning();
  } catch (error) { $("saveStatus").textContent = `Não foi possível importar: ${error.message}`; }
});
$("clearLearning").addEventListener("click", async () => {
  if (!confirm("Apagar todos os códigos aprendidos? A extensão voltará a perguntar nas combinações sem regra.")) return;
  try { await send({ type: "CLEAR_LEARNING" }); await loadLearning(); }
  catch (error) { $("saveStatus").textContent = error.message; }
});

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (!response?.ok) reject(new Error(response?.error || "Falha de comunicação."));
    else resolve(response);
  }));
}

function cell(text) {
  const element = document.createElement("td");
  element.textContent = text == null || text === "" ? "—" : String(text);
  return element;
}

function renderHistory(history) {
  const body = $("historyBody");
  body.replaceChildren();
  if (!Array.isArray(history) || !history.length) {
    const row = document.createElement("tr");
    const empty = cell("Nenhuma execução registrada.");
    empty.colSpan = 7;
    empty.className = "empty";
    row.appendChild(empty);
    body.appendChild(row);
    return;
  }
  [...history].reverse().forEach(item => {
    const row = document.createElement("tr");
    [item.dataHora, item.numeroChamado, item.codigoBaixa, item.resultado, item.iaUtilizada, item.confianca === "" ? "" : `${Math.round(Number(item.confianca) * 100)}%`, item.erro || item.motivo].forEach(value => row.appendChild(cell(value)));
    body.appendChild(row);
  });
}

async function load() {
  const result = await send({ type: "GET_OPTIONS" });
  const settings = result.settings;
  hasSavedKey = result.hasApiKey;
  $("provider").value = settings.provider || "gemini";
  $("model").value = settings.model || defaultModel(settings.provider);
  $("model").dataset.provider = $("provider").value;
  updateProviderHelp();
  $("temperature").value = String(settings.temperature ?? 0);
  $("confidence").value = String(settings.minimumConfidence ?? 0.85);
  $("mode").value = settings.mode || "analysis";
  $("keyStatus").textContent = hasSavedKey ? "Chave salva · conexão não testada" : "Chave não salva";
  setHistory(result.history);
  await loadLearning();
}

function defaultModel(provider) {
  return BaixaHelpers.DEFAULT_MODELS[provider === "groq" ? "groq" : "gemini"];
}

function updateProviderHelp() {
  const groq = $("provider").value === "groq";
  const help = $("providerHelp");
  $("apiKey").placeholder = groq
    ? "Cole uma chave criada em console.groq.com/keys"
    : "Cole uma chave criada no Google AI Studio";
  $("testApi").textContent = groq ? "Salvar e testar Groq" : "Salvar e testar Gemini";
  help.replaceChildren(document.createTextNode(groq ? "Crie uma chave no Groq Console: " : "Crie uma chave no Google AI Studio: "));
  const link = document.createElement("a");
  link.href = groq ? "https://console.groq.com/keys" : "https://aistudio.google.com/apikey";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = groq ? "Groq API Keys" : "Google AI Studio API Keys";
  help.appendChild(link);
  if (!$("model").value || $("model").dataset.provider !== $("provider").value) {
    $("model").value = defaultModel($("provider").value);
  }
  $("model").dataset.provider = $("provider").value;
}

$("provider").addEventListener("change", async () => {
  $("apiKey").value = "";
  $("privacyConsent").checked = false;
  const provider = $("provider").value;
  try {
    const stored = await send({ type: "GET_OPTIONS", provider });
    hasSavedKey = stored.hasApiKey;
    $("keyStatus").textContent = hasSavedKey ? "Chave deste provedor salva · conexão não testada" : "Chave deste provedor não salva";
  } catch {
    hasSavedKey = false;
    $("keyStatus").textContent = "Chave deste provedor não verificada";
  }
  $("saveStatus").textContent = "As chaves Gemini e Groq ficam separadas. Cole uma chave nova e use “Salvar e testar” para conectar em uma etapa.";
  updateProviderHelp();
});

$("showKey").addEventListener("change", event => { $("apiKey").type = event.target.checked ? "text" : "password"; });
$("removeKey").addEventListener("change", event => {
  $("apiKey").disabled = event.target.checked;
  if (event.target.checked) $("apiKey").value = "";
});

async function saveFormSettings() {
  const apiKey = $("apiKey").value.trim();
  const settings = {
    provider: $("provider").value,
    apiKey,
    deleteApiKey: $("removeKey").checked,
    model: $("model").value.trim(),
    temperature: Number($("temperature").value),
    minimumConfidence: Number($("confidence").value),
    mode: $("mode").value
  };
  if (apiKey && !$("privacyConsent").checked) throw new Error("Confirme o aviso de privacidade antes de configurar a IA.");
  if (settings.mode === "automatic" && !confirm("O modo automático altera os campos e aciona Gravar Baixa após as validações. Deseja manter este modo?")) {
    $("mode").value = "analysis";
    settings.mode = "analysis";
  }
  await send({ type: "SAVE_OPTIONS", settings });
  $("apiKey").value = "";
  $("removeKey").checked = false;
  $("apiKey").disabled = false;
  hasSavedKey = settings.deleteApiKey ? false : Boolean(apiKey) || hasSavedKey;
  return settings;
}

$("settingsForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("saveStatus").textContent = "Salvando…";
  try {
    await saveFormSettings();
    $("saveStatus").textContent = "Configurações salvas no armazenamento local.";
    await load();
  } catch (error) { $("saveStatus").textContent = error.message; }
});

$("testApi").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  if ($("removeKey").checked && !apiKey) {
    $("saveStatus").textContent = "A chave está marcada para remoção. Cole uma nova chave ou desmarque “Remover a chave salva” antes de testar.";
    return;
  }
  if (!apiKey && !hasSavedKey) {
    $("saveStatus").textContent = "Cole uma chave nova do provedor selecionado para conectar a IA.";
    return;
  }
  if (!$("privacyConsent").checked) {
    $("saveStatus").textContent = "Confirme o aviso de privacidade antes de enviar o teste.";
    return;
  }
  const button = $("testApi");
  button.disabled = true;
  button.textContent = "Salvando e testando…";
  const provider = $("provider").value;
  const model = $("model").value.trim();
  const temperature = Number($("temperature").value);
  $("saveStatus").textContent = `Salvando a configuração e testando a conexão com ${provider === "groq" ? "Groq" : "Gemini"} usando dados sintéticos…`;
  try {
    await saveFormSettings();
    const result = await send({ type: "TEST_AI_API", settings: {
      provider,
      model,
      temperature,
      privacyConsent: $("privacyConsent").checked
    } });
    $("keyStatus").textContent = `Conexão ${result.test.provider} validada`;
    $("saveStatus").textContent = `API respondeu com JSON estruturado (${result.test.model}). Teste sintético concluído; a classificação do chamado ainda será comparada às regras locais.`;
  } catch (error) {
    $("keyStatus").textContent = "Conexão não validada";
    $("saveStatus").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = provider === "groq" ? "Salvar e testar Groq" : "Salvar e testar Gemini";
  }
});

$("exportCsv").addEventListener("click", async () => {
  let result;
  try { result = await send({ type: "GET_OPTIONS" }); }
  catch (error) { $("saveStatus").textContent = error.message; return; }
  const rows = [
    ["Data/hora", "Chamado", "Código", "Resultado", "IA", "Confiança", "Motivo", "Erro"],
    ...(result.history || []).map(item => [item.dataHora, item.numeroChamado, item.codigoBaixa, item.resultado, item.iaUtilizada, item.confianca, item.motivo, item.erro])
  ];
  const csv = "\uFEFF" + rows.map(row => row.map(BaixaHelpers.escapeCsv).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `historico-baixa-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

$("clearHistory").addEventListener("click", async () => {
  if (!confirm("Apagar todo o histórico local desta extensão?")) return;
  await chrome.storage.local.set({ baixaHistory: [] });
  await load();
});

void load().catch(error => { $("saveStatus").textContent = error.message; });
