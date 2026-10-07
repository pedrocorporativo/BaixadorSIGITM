"use strict";

importScripts(
  "../utils/helpers.js",
  "../automation/batch-handler.js",
  "../storage/storage.js",
  "../rules/baixa-rules.js",
  "../rules/validation.js",
  "../ai/ai-schema.js",
  "../ai/ai-provider.js",
  "../ai/ai-service.js",
  "run-guard.js"
);

const SIGITM_HOST = "sigitm.redecorp.br";
const BATCH_STORAGE_KEY = "baixaBatchRun";
const MASSIVE_LIST_URL = "http://sigitm.redecorp.br/SIGITMWeb/pages/consulta/listConsulta.jsf?idConsulta=95803";
const activeRuns = new Map();
const batchRuns = new Map();
let startQueue = Promise.resolve();

function makeToolbarIcon(size) {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const center = size / 2;
  context.clearRect(0, 0, size, size);
  context.fillStyle = "#d8f522";
  context.beginPath();
  context.arc(center, center, size * 0.48, 0, Math.PI * 2);
  context.fill();
  const globe = context.createRadialGradient(center - size * 0.15, center - size * 0.18, size * 0.03, center, center, size * 0.34);
  globe.addColorStop(0, "#4264e8");
  globe.addColorStop(1, "#07105b");
  context.fillStyle = globe;
  context.beginPath();
  context.arc(center, center, size * 0.34, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.beginPath();
  context.arc(center, center, size * 0.32, 0, Math.PI * 2);
  context.clip();
  context.strokeStyle = "#dfe6ff";
  context.globalAlpha = 0.45;
  context.lineWidth = Math.max(1, size * 0.025);
  context.beginPath();
  context.ellipse(center, center, size * 0.19, size * 0.32, 0, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.ellipse(center, center, size * 0.32, size * 0.12, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#11143a";
  context.lineWidth = size * 0.16;
  context.beginPath();
  context.moveTo(size * 0.27, size * 0.27);
  context.lineTo(size * 0.73, size * 0.73);
  context.moveTo(size * 0.73, size * 0.27);
  context.lineTo(size * 0.27, size * 0.73);
  context.stroke();
  context.strokeStyle = "#e3262e";
  context.lineWidth = size * 0.09;
  context.beginPath();
  context.moveTo(size * 0.27, size * 0.27);
  context.lineTo(size * 0.73, size * 0.73);
  context.moveTo(size * 0.73, size * 0.27);
  context.lineTo(size * 0.27, size * 0.73);
  context.stroke();
  return context.getImageData(0, 0, size, size);
}

function setToolbarIcon() {
  if (!chrome.action?.setIcon) return;
  const imageData = Object.fromEntries([16, 32, 48, 128].map(size => [size, makeToolbarIcon(size)]).filter(([, image]) => image));
  if (Object.keys(imageData).length) chrome.action.setIcon({ imageData }, () => void chrome.runtime.lastError);
}

setToolbarIcon();

const CONTENT_FILES = [
  "utils/helpers.js",
  "rules/baixa-rules.js",
  "rules/validation.js",
  "automation/navigation.js",
  "automation/batch-handler.js",
  "automation/date-handler.js",
  "automation/form-handler.js",
  "automation/baixa-handler.js",
  "ui/notifications.js",
  "content/content.js"
];

function senderIsExtension(sender) { return sender.id === chrome.runtime.id; }
function senderIsSigitm(sender) {
  try { return new URL(sender.url || "").hostname === SIGITM_HOST; } catch { return false; }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, response => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}

function injectContent(tabId) {
  return new Promise((resolve, reject) => chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  }, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

async function startContent(tabId, runId, batch = null) {
  try {
    const response = await sendTabMessage(tabId, { type: "START_ANALYSIS", runId, batch });
    if (response?.ok) return;
    throw new Error(response?.error || "O content script não confirmou o início do ticket.");
  } catch {
    // Recupera páginas carregadas antes da extensão ou após ela ser recarregada.
    await injectContent(tabId);
    try {
      const response = await sendTabMessage(tabId, { type: "START_ANALYSIS", runId, batch });
      if (response?.ok) return;
      throw new Error(response?.error || "O content script não confirmou o início do ticket.");
    } catch (error) {
      throw new Error(`O content script não conectou após a reinjeção: ${error.message}`);
    }
  }
}

async function sendBatchListMessage(tabId, message) {
  let response;
  try { response = await sendTabMessage(tabId, message); } catch { /* pode estar sem content script ou com listener antigo */ }
  if (response?.ok) return response;
  await injectContent(tabId);
  try { response = await sendTabMessage(tabId, message); }
  catch (error) { throw new Error(`Content script indisponível na tabela: ${error.message}`); }
  if (!response?.ok) throw new Error(response?.error || "A lista SIGITM não respondeu. Atualize a guia e tente novamente.");
  return response;
}

function sendBatchStatus(batch, message, status = "info") {
  if (!batch || typeof batch.listTabId !== "number") return;
  chrome.tabs.sendMessage(batch.listTabId, { type: "BATCH_STATUS", message, status }, () => void chrome.runtime.lastError);
}

function serializeBatch(batch) {
  return {
    batchId: batch.batchId,
    listTabId: batch.listTabId,
    listName: batch.listName,
    processed: [...batch.processed],
    sequence: batch.sequence,
    ticketTabId: batch.ticketTabId,
    ticketRunId: batch.ticketRunId,
    refreshAttempted: batch.refreshAttempted,
    ticketUncertain: batch.ticketUncertain,
    finished: batch.finished
  };
}

async function persistBatch(batch) {
  if (batch && !batch.finished) await BaixaStorage.set({ [BATCH_STORAGE_KEY]: serializeBatch(batch) });
}

async function loadBatch(batchId) {
  const existing = batchRuns.get(batchId);
  if (existing) return existing;
  const stored = await BaixaStorage.get(BATCH_STORAGE_KEY);
  const value = stored[BATCH_STORAGE_KEY];
  if (!value || value.batchId !== batchId || value.finished) return null;
  const batch = { ...value, processed: new Set(value.processed || []), processing: false };
  batchRuns.set(batchId, batch);
  return batch;
}

function queryTabs() {
  return new Promise((resolve, reject) => chrome.tabs.query({}, tabs => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(tabs || []);
  }));
}

async function waitForTicketTabChange(previousTabs, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tabs = await queryTabs();
    const ticketTab = tabs.find(tab => {
      if (typeof tab.id !== "number" || !tab.url) return false;
      try {
        const url = new URL(tab.url);
        if (url.hostname !== SIGITM_HOST || url.pathname.toLowerCase().endsWith("/listconsulta.jsf")) return false;
        const previous = previousTabs.get(tab.id);
        return !previous || previous.url !== tab.url || (tab.active && !previous.active);
      } catch { return false; }
    });
    if (ticketTab) return ticketTab.id;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Os dois cliques na sequência não abriram uma nova guia de chamado.");
}

function ticketUrlFromLink(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.hostname !== SIGITM_HOST ||
      !url.pathname.startsWith("/SIGITMWeb/") || url.pathname.toLowerCase().endsWith("/listconsulta.jsf")) return "";
    return url.href;
  } catch { return ""; }
}

function openTicketUrl(url, openerTabId) {
  return new Promise((resolve, reject) => chrome.tabs.create({ url, openerTabId, active: true }, tab => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (typeof tab?.id !== "number") reject(new Error("O Chrome não criou a guia do ticket."));
    else resolve(tab.id);
  }));
}

async function clickSequenceInPage(tabId, sequence) {
  const executions = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async wantedSequence => {
      const normalize = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const cellsFor = row => [...row.querySelectorAll("th, td")];
      const seqIndex = cells => cells.findIndex(cell => {
        const label = normalize([cell.innerText, cell.textContent, cell.getAttribute("aria-label"), cell.title]
          .filter(Boolean).join(" ").replace(/[↕↔↑↓⇅⇵▲▼]/g, " "));
        return label === "seq" || label.startsWith("seq ");
      });
      const tables = [...document.querySelectorAll("table")];
      for (const table of tables) {
        const rows = [...table.querySelectorAll("tr")];
        const headerRow = rows.find(row => seqIndex(cellsFor(row)) >= 0);
        if (!headerRow) continue;
        const index = seqIndex(cellsFor(headerRow));
        for (const row of rows.slice(rows.indexOf(headerRow) + 1)) {
          const cell = cellsFor(row)[index];
          const number = normalize(cell?.innerText || cell?.textContent).match(/\b\d{5,20}\b/)?.[0];
          if (number !== String(wantedSequence)) continue;
          const target = cell.querySelector("a, button, [role='link'], [onclick], [tabindex]") || cell;
          const link = target.closest("a") || cell.querySelector("a");
          const rawHref = String(link?.getAttribute("href") || "").trim();
          const handler = String(link?.getAttribute("onclick") || target.getAttribute("onclick") || "");
          const literalWindowUrl = handler.match(/(?:window\s*\.\s*)?open\s*\(\s*(['"])(.*?)\1/i)?.[2] ||
            rawHref.match(/^javascript:\s*(?:window\s*\.\s*)?open\s*\(\s*(['"])(.*?)\1/i)?.[2] || "";
          let href = "";
          const rawUrl = literalWindowUrl || (!/^(?:javascript:|#|mailto:)/i.test(rawHref) ? rawHref : "");
          if (rawUrl) {
            try { href = new URL(rawUrl, location.href).href; } catch { href = ""; }
          }
          const openedUrls = [];
          const originalOpen = window.open;
          window.open = function (...args) {
            if (args[0]) {
              try { openedUrls.push(new URL(String(args[0]), location.href).href); }
              catch { /* URL dinâmica inválida: tab detector continua ativo */ }
            }
            return originalOpen.apply(this, args);
          };
          try {
            target.click();
            await new Promise(resolve => setTimeout(resolve, 250));
            target.click();
            target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window, detail: 2 }));
          } finally {
            window.open = originalOpen;
          }
          return { clicked: true, href: href || openedUrls.find(value => value) || "", openedUrls };
        }
      }
      return { clicked: false, href: "", openedUrls: [] };
    },
    args: [String(sequence)]
  });
  return executions?.[0]?.result || { clicked: false, href: "", openedUrls: [] };
}

function activateTab(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.update(tabId, { active: true }, tab => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(tab);
  }));
}

async function returnToListAndRefresh(batch) {
  await activateTab(batch.listTabId);
  const refreshed = await sendBatchListMessage(batch.listTabId, { type: "REFRESH_BATCH_LIST" });
  if (!refreshed?.ok) throw new Error(refreshed?.error || "Não foi possível atualizar a lista após fechar o ticket.");
  return refreshed.state;
}

async function continueMassiveListFromTicket(ticketTabId) {
  const tabs = await queryTabs();
  let listTab = tabs.find(tab => BaixaBatch.listName(tab.url || "") === "Validação Massiva");
  if (!listTab) {
    listTab = await new Promise((resolve, reject) => chrome.tabs.create({ url: MASSIVE_LIST_URL, active: true }, tab => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!tab?.id) reject(new Error("Não foi possível abrir a consulta Validação Massiva."));
      else resolve(tab);
    }));
  }
  if (typeof listTab.id !== "number") throw new Error("A guia da consulta Validação Massiva não possui identificador válido.");

  // Só avança depois que o content script confirmou “Ticket liberado”.
  activeRuns.delete(ticketTabId);
  await BaixaStorage.set({ baixaActiveRun: null });
  await activateTab(listTab.id);
  const refreshed = await sendBatchListMessage(listTab.id, { type: "REFRESH_BATCH_LIST" });
  if (!refreshed?.ok) throw new Error(refreshed?.error || "Não foi possível atualizar a consulta Validação Massiva.");

  try { await chrome.tabs.remove(ticketTabId); } catch { /* guia já fechada */ }
  if (refreshed.state?.empty) return { started: false, empty: true };
  const batch = await startBatchForTab(listTab.id, "Validação Massiva");
  sendBatchStatus(batch, "Consulta atualizada. Abrindo o próximo BD da coluna Seq…");
  void processNextBatchTicket(batch);
  return { started: true, empty: false, batchId: batch.batchId };
}

function waitForTicketTabReady(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const settle = (error, tab) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(tab);
    };
    const inspect = tab => {
      if (!tab?.url || tab.status !== "complete") return false;
      try {
        const url = new URL(tab.url);
        if (url.hostname !== SIGITM_HOST || url.pathname.toLowerCase().endsWith("/listconsulta.jsf")) return false;
        settle(null, tab);
        return true;
      } catch { return false; }
    };
    const onUpdated = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") inspect(tab);
    };
    const timer = setTimeout(() => settle(new Error("A guia do chamado não terminou de carregar.")), timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) return settle(new Error(chrome.runtime.lastError.message));
      inspect(tab);
    });
  });
}

async function finishBatch(batch, message, status = "success") {
  if (!batch || batch.finished) return;
  batch.finished = true;
  batchRuns.delete(batch.batchId);
  await BaixaStorage.set({ [BATCH_STORAGE_KEY]: null }).catch(() => undefined);
  sendBatchStatus(batch, message, status);
  // Não feche guias de ticket em caminhos genéricos de erro/parada. O único
  // fechamento automático ocorre no handler BATCH_TICKET_FINISHED, após a
  // confirmação de sucesso ter sido lida na página.
}

async function processNextBatchTicket(batch) {
  if (!batch || batch.finished || batch.processing || batch.ticketTabId) return;
  batch.processing = true;
  try {
    const response = await sendBatchListMessage(batch.listTabId, { type: "READ_BATCH_LIST_STATE" });
    const state = response.state || { tickets: [], empty: false };
    if (state.empty) {
      await finishBatch(batch, `Lista ${batch.listName}: zero registros. Processamento encerrado (${batch.processed.size} tickets concluídos).`);
      return;
    }
    const sequence = state.tickets.find(item => !batch.processed.has(String(item)));
    if (!sequence) {
      if (state.recordCount?.total > 0) {
        throw new Error(`A tabela informa ${state.recordCount.total} registros, mas a extensão não conseguiu ler nenhuma sequência na coluna Seq.`);
      }
      if (!batch.refreshAttempted) {
        batch.refreshAttempted = true;
        await persistBatch(batch);
        const refresh = await sendBatchListMessage(batch.listTabId, { type: "REFRESH_BATCH_LIST" });
        setTimeout(() => void processNextBatchTicket(batch), 0);
        return;
      }
      await finishBatch(batch, `Lista ${batch.listName}: não há novas sequências visíveis após atualizar (${batch.processed.size} tickets concluídos). A consulta ainda não confirmou zero registros.`, "error");
      return;
    }
    batch.refreshAttempted = false;
    batch.sequence = String(sequence);
    await persistBatch(batch);
    sendBatchStatus(batch, `${batch.listName}: abrindo ticket ${batch.sequence} (${batch.processed.size + 1} concluídos até agora)…`);
    const previousTabs = new Map((await queryTabs()).map(tab => [tab.id, { url: tab.url || "", active: Boolean(tab.active) }]));
    if (previousTabs.has(batch.listTabId)) previousTabs.get(batch.listTabId).active = true;
    const clickResult = await clickSequenceInPage(batch.listTabId, batch.sequence);
    if (!clickResult?.clicked) throw new Error(clickResult?.error || `Não foi possível clicar na sequência ${batch.sequence} da coluna Seq.`);
    const directTicketUrl = ticketUrlFromLink(clickResult.href || "");
    let ticketTabId = await waitForTicketTabChange(previousTabs, directTicketUrl ? 2500 : 30000).catch(() => null);
    if (ticketTabId === null && directTicketUrl) ticketTabId = await openTicketUrl(directTicketUrl, batch.listTabId);
    if (ticketTabId === null) throw new Error(`Os dois cliques rápidos na sequência ${batch.sequence} não abriram uma guia SIGITM.`);
    if (batch.finished) {
      return;
    }
    batch.ticketTabId = ticketTabId;
    await persistBatch(batch);
    const readyTab = await waitForTicketTabReady(ticketTabId);
    if (batch.finished) {
      return;
    }
    const runId = crypto.randomUUID();
    batch.ticketRunId = runId;
    await persistBatch(batch);
    const controller = new AbortController();
    activeRuns.set(ticketTabId, { runId, controller });
    await BaixaStorage.set({
      [BaixaStorage.KEYS.stop]: false,
      baixaActiveTabId: ticketTabId,
      baixaActiveRun: { tabId: ticketTabId, runId, startedAt: new Date().toISOString(), stopped: false }
    });
    if (readyTab.status !== "complete") throw new Error("A guia do ticket não terminou de carregar.");
    try {
      await startContent(ticketTabId, runId, { batchId: batch.batchId, sequence: batch.sequence });
    } catch (error) {
      batch.ticketUncertain = true;
      throw new Error(`${error.message} A guia do ticket foi mantida aberta para conferência.`);
    }
  } catch (error) {
    await finishBatch(batch, `${batch.listName}: fila pausada. ${error.message}`, "error");
  } finally {
    batch.processing = false;
  }
}

async function startBatchForTab(tabId, listName) {
  if ([...batchRuns.values()].some(batch => !batch.finished) || [...activeRuns.values()].some(run => !run.controller.signal.aborted)) {
    throw new Error("Já existe uma automação ativa. Pare-a antes de iniciar outro processamento.");
  }
  const stored = await BaixaStorage.get("baixaActiveRun");
  if (stored.baixaActiveRun && !stored.baixaActiveRun.stopped) {
    throw new Error("Já existe uma execução ativa. Pare-a antes de iniciar o processamento da lista.");
  }
  const batch = {
    batchId: crypto.randomUUID(),
    listTabId: tabId,
    listName,
    processed: new Set(),
    sequence: "",
    ticketTabId: null,
    ticketRunId: "",
    processing: false,
    refreshAttempted: false,
    ticketUncertain: false,
    finished: false
  };
  batchRuns.set(batch.batchId, batch);
  await persistBatch(batch);
  return batch;
}

async function saveCurrent(result) {
  const record = { ...result, updatedAt: new Date().toISOString() };
  await BaixaStorage.set({ [BaixaStorage.KEYS.current]: record });
  return record;
}

async function handleCase(message, sender) {
  if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") throw new Error("Origem de chamado não autorizada.");
  const tabId = sender.tab.id;
  const runId = String(message.runId || "");
  let activeRun = activeRuns.get(tabId);
  const storedRun = (await BaixaStorage.get(["baixaActiveRun", BaixaStorage.KEYS.stop]));
  const persistentRun = storedRun.baixaActiveRun;
    const hasOtherActiveRun = [...activeRuns.entries()].some(([activeTabId, run]) =>
      activeTabId !== tabId && !run.controller.signal.aborted);
    const authorization = BaixaRunGuard.authorizeRun({
      tabId,
      runId,
      persistentRun,
      memoryRun: activeRun,
      stopRequested: storedRun[BaixaStorage.KEYS.stop] === true,
      hasOtherActiveRun
    });
    if (!authorization.allowed) {
      const guidance = authorization.reason === "ID da execução ausente."
        ? "ID da execução ausente. Feche e reabra a página SIGITM, depois inicie pela extensão."
        : authorization.reason === "A automação foi interrompida."
          ? "A execução foi parada ou abortada. Clique em Analisar chamado atual para iniciar uma nova execução."
          : authorization.reason;
      throw new Error(guidance);
    }
    if (authorization.repairStorage) {
      await BaixaStorage.set({
        [BaixaStorage.KEYS.stop]: false,
        baixaActiveTabId: tabId,
        baixaActiveRun: { tabId, runId, startedAt: new Date().toISOString(), stopped: false }
      });
    }

  if (activeRun?.runId === runId && activeRun.controller.signal.aborted) throw new Error("Automação interrompida pelo usuário.");
  if (!activeRun || activeRun.runId !== runId) {
    activeRun = { runId, controller: new AbortController() };
    activeRuns.set(tabId, activeRun);
  }
  if (activeRun.controller.signal.aborted) throw new Error("Automação interrompida pelo usuário.");
  const rawCase = message.caseData;
  if (!rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) throw new Error("Dados do chamado inválidos.");

  const data = Object.fromEntries(BaixaHelpers.CASE_FIELDS.map(key => [key, rawCase[key] ?? ""]));
  const deterministic = BaixaRules.decide(data);
  const automaticClientCode = BaixaRules.automaticCodeForClient(data.cliente);
  const settings = await BaixaStorage.getSettings();
  const controller = activeRun.controller;

  const ai = await BaixaAIService.analyzeCase(data, settings, controller.signal);
  if (controller.signal.aborted) throw new Error("Automação interrompida pelo usuário.");
  const validation = automaticClientCode
    ? {
      allowed: deterministic.allowed,
      status: "REGRA PRIORITÁRIA DO CLIENTE",
      reason: `Cliente SEDUC: código ${automaticClientCode} aplicado sem perguntar e sem depender da resposta da IA.`
    }
    : BaixaValidation.compareAIWithRules(ai, deterministic, settings.minimumConfidence);
  const decision = {
    ...deterministic,
    validation,
    ai: ai.available ? {
      available: true,
      provider: ai.provider,
      confidence: ai.decision.confianca,
      motivo: ai.decision.motivo,
      proposedCode: ai.decision.codigoBaixa
    } : {
      available: false,
      provider: settings.provider,
      confidence: null,
      motivo: ai.reason
    },
    allowed: deterministic.allowed && validation.allowed,
    mode: settings.mode,
    caseData: data,
    analyzedAt: new Date().toISOString()
  };
  decision.learnedCode = await BaixaStorage.getLearnedCode(data);
  await saveCurrent(decision);
  return decision;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "RUN_ACTIVE_TAB") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      let url;
      try { url = new URL(tab?.url || ""); } catch { url = null; }
      if (!tab?.id || url?.hostname !== SIGITM_HOST || !url.pathname.startsWith("/SIGITMWeb/")) {
        sendResponse({ ok: false, error: "Abra um chamado SIGITM ou uma tabela compatível na aba atual." });
        return;
      }
      const listName = BaixaBatch.listName(url.href);
      if (listName) {
        const batchStart = startQueue.then(() => startBatchForTab(tab.id, listName));
        startQueue = batchStart.catch(() => undefined);
        batchStart.then(batch => {
          sendBatchStatus(batch, `Iniciando ${listName}. Os tickets da coluna Seq serão tratados um por vez; a guia só fecha após “Ticket liberado”.`);
          sendResponse({ ok: true, batchId: batch.batchId, listName });
          void processNextBatchTicket(batch);
        }).catch(error => sendResponse({ ok: false, error: error.message || "Não foi possível iniciar a lista SIGITM." }));
        return;
      }
      let allocatedRunId = "";
      const start = startQueue.then(async () => {
        const current = (await BaixaStorage.get("baixaActiveRun")).baixaActiveRun;
        if (current && !current.stopped && current.tabId !== tab.id) {
          throw new Error("Já existe um chamado ativo em outra aba. Use PARAR AUTOMAÇÃO antes de iniciar este chamado.");
        }
        if (current && !current.stopped && current.tabId === tab.id) {
          // Um clique explícito em Analisar na mesma guia substitui um lock
          // deixado por suspensão/erro. O content script cancela a execução
          // antiga antes de iniciar a nova solicitação.
          activeRuns.get(tab.id)?.controller.abort();
          try {
            await sendTabMessage(tab.id, { type: "STOP_AUTOMATION", runId: current.runId });
          } catch {
            // Uma página recarregada pode já não ter o listener antigo.
          }
        }
        const runId = crypto.randomUUID();
        allocatedRunId = runId;
        activeRuns.get(tab.id)?.controller.abort();
        activeRuns.set(tab.id, { runId, controller: new AbortController() });
        await BaixaStorage.set({
          [BaixaStorage.KEYS.stop]: false,
          baixaActiveTabId: tab.id,
          baixaActiveRun: { tabId: tab.id, runId, startedAt: new Date().toISOString(), stopped: false }
        });
        if (activeRuns.get(tab.id)?.runId !== runId || activeRuns.get(tab.id)?.controller.signal.aborted) {
          throw new Error("A execução foi interrompida antes de iniciar.");
        }
        await startContent(tab.id, runId);
        return runId;
      });
      startQueue = start.catch(() => undefined);
      start.then(runId => sendResponse({ ok: true, runId })).catch(error => {
        const currentRun = activeRuns.get(tab.id);
        if (!allocatedRunId || currentRun?.runId === allocatedRunId) {
          currentRun?.controller.abort();
          activeRuns.delete(tab.id);
        }
        BaixaStorage.get("baixaActiveRun").then(async stored => {
          if (stored.baixaActiveRun?.runId === allocatedRunId) await BaixaStorage.set({ baixaActiveRun: null });
          sendResponse({ ok: false, error: error.message || "Content script indisponível; atualize o SIGITM." });
        }).catch(() => sendResponse({ ok: false, error: error.message || "Content script indisponível; atualize o SIGITM." }));
      });
    });
    return true;
  }

  if (message?.type === "CONTINUE_MASSIVE_LIST") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    continueMassiveListFromTicket(sender.tab.id)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Não foi possível voltar à Validação Massiva." }));
    return true;
  }

  if (message?.type === "STOP_AUTOMATION") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const stop = startQueue.then(async () => {
      const tabIds = [...activeRuns.keys()];
      tabIds.forEach(tabId => activeRuns.get(tabId)?.controller.abort());
      const stored = await BaixaStorage.get("baixaActiveRun");
      const run = stored.baixaActiveRun;
      const stopTabs = new Set(tabIds);
      if (typeof run?.tabId === "number") stopTabs.add(run.tabId);
      await BaixaStorage.set({
        [BaixaStorage.KEYS.stop]: true,
        baixaActiveRun: run ? { ...run, stopped: true, stoppedAt: new Date().toISOString() } : null
      });
      stopTabs.forEach(tabId => chrome.tabs.sendMessage(tabId, { type: "STOP_AUTOMATION", runId: run?.runId }, () => void chrome.runtime.lastError));
      const storedBatch = await BaixaStorage.get(BATCH_STORAGE_KEY);
      if (storedBatch[BATCH_STORAGE_KEY]?.batchId && !batchRuns.has(storedBatch[BATCH_STORAGE_KEY].batchId)) {
        await loadBatch(storedBatch[BATCH_STORAGE_KEY].batchId);
      }
      for (const batch of batchRuns.values()) {
        batch.ticketUncertain = Boolean(batch.ticketTabId);
        await finishBatch(batch, `Processamento da lista ${batch.listName} interrompido pelo usuário.`, "error");
      }
    });
    startQueue = stop.catch(() => undefined);
    stop.then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "ANALYZE_CASE") {
    handleCase(message, sender).then(decision => sendResponse({ ok: true, decision }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_CODE_LEARNING") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const code = String(message.codigoBaixa || "");
    const rawCase = message.caseData;
    if (!BaixaRules.CODES.includes(code) || !rawCase || typeof rawCase !== "object" || Array.isArray(rawCase)) {
      sendResponse({ ok: false, error: "Código ou dados de aprendizagem inválidos." });
      return false;
    }
    BaixaStorage.get("baixaActiveRun").then(async stored => {
      const run = stored.baixaActiveRun;
      if (run?.runId !== message.runId || run?.tabId !== sender.tab.id || run.stopped) throw new Error("A execução não está mais ativa para salvar a escolha.");
      const caseData = Object.fromEntries(BaixaHelpers.CASE_FIELDS.map(key => [key, rawCase[key] ?? ""]));
      const learning = await BaixaStorage.saveLearnedCode(caseData, code);
      const currentState = await BaixaStorage.get(BaixaStorage.KEYS.current);
      const current = currentState[BaixaStorage.KEYS.current] || {};
      const source = message.source === "aprendido" ? "aprendido" : "usuário";
      const sourceLabel = source === "aprendido" ? "reutilizado da escolha salva" : "escolhido pelo usuário";
      await saveCurrent({
        ...current,
        codigoBaixa: code,
        motivo: `Código ${code} ${sourceLabel}.`,
        validation: {
          ...current.validation,
          allowed: true,
          status: source === "aprendido" ? "CÓDIGO APRENDIDO" : "CÓDIGO CONFIRMADO PELO USUÁRIO",
          reason: `Código ${code} ${sourceLabel}.`
        },
        codeSelection: { source, codigoBaixa: code, ocorrencias: learning.ocorrencias }
      });
      return { codigoBaixa: code, ocorrencias: learning.ocorrencias };
    }).then(learning => sendResponse({ ok: true, learning }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RUN_FINISHED") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false }); return false; }
    BaixaStorage.get("baixaActiveRun").then(async stored => {
      const run = stored.baixaActiveRun;
      const matchesRun = run?.tabId === sender.tab.id && run?.runId === message.runId;
      if (matchesRun) await BaixaStorage.set({ baixaActiveRun: null });
      if (activeRuns.get(sender.tab.id)?.runId === message.runId) activeRuns.delete(sender.tab.id);
      sendResponse({ ok: true, cleared: matchesRun });
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "BATCH_TICKET_FINISHED") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const batchId = String(message.batchId || "");
    loadBatch(batchId).then(async batch => {
      if (!batch || batch.ticketTabId !== sender.tab.id || batch.sequence !== String(message.sequence || "")) {
        sendResponse({ ok: false, error: "O ticket não corresponde à execução em lote ativa." });
        return;
      }
      if (message.uncertain) {
        batch.ticketUncertain = true;
        await finishBatch(batch, `Fila pausada no ticket ${batch.sequence}: ${message.reason || "o processamento do ticket não foi concluído."} A guia foi mantida aberta para corrigir os campos e conferir a baixa.`, "error");
        sendResponse({ ok: true, paused: true });
        return;
      }
      if (message.cancelled) {
        await finishBatch(batch, `Fila cancelada durante o ticket ${batch.sequence}.`, "error");
        sendResponse({ ok: true, cancelled: true });
        return;
      }
      batch.processed.add(batch.sequence);
      const finishedTicketTabId = batch.ticketTabId;
      batch.ticketTabId = null;
      batch.ticketRunId = "";
      activeRuns.delete(finishedTicketTabId);
      await persistBatch(batch);
      try { await chrome.tabs.remove(finishedTicketTabId); } catch { /* guia já fechada */ }
      try {
        sendBatchStatus(batch, `Ticket ${batch.sequence} fechado. Voltando à tabela e clicando em Atualizar…`);
        const refreshedState = await returnToListAndRefresh(batch);
        sendResponse({ ok: true, success: message.success === true, refreshed: true });
        if (message.success !== true) sendBatchStatus(batch, `Ticket ${batch.sequence} não foi baixado; registro atualizado e a fila continuará.`, "error");
        if (refreshedState?.empty) {
          await finishBatch(batch, `Lista ${batch.listName}: zero registros após atualizar. Processamento encerrado (${batch.processed.size} tickets concluídos).`);
          return;
        }
        void processNextBatchTicket(batch);
      } catch (error) {
        await finishBatch(batch, `Fila pausada após fechar o ticket ${batch.sequence}: ${error.message}`, "error");
        sendResponse({ ok: false, error: error.message });
      }
    }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RECORD_FINAL_RESULT") {
    if (!senderIsSigitm(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const record = message.record;
    BaixaStorage.get("baixaActiveRun").then(async stored => {
      const run = stored.baixaActiveRun;
      if (run?.runId !== message.runId || run?.tabId !== sender.tab?.id) return;
      await BaixaStorage.addHistory(record || {});
      if (record?.resultado === "PROCESSAMENTO INTERROMPIDO") return;
      const currentState = await BaixaStorage.get(BaixaStorage.KEYS.current);
      const current = currentState[BaixaStorage.KEYS.current] || {};
      return saveCurrent({ ...current, executionResult: record?.resultado || "", executionError: record?.erro || "" });
    })
      .then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_EXTENSION_STATE") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    Promise.all([BaixaStorage.get([BaixaStorage.KEYS.current, BaixaStorage.KEYS.history, BaixaStorage.KEYS.stop, "baixaAiConnectionStatus", "baixaActiveRun", BATCH_STORAGE_KEY]), BaixaStorage.getSettings()])
      .then(([stored, settings]) => {
        const activeRun = stored.baixaActiveRun;
        const activeBatch = stored[BATCH_STORAGE_KEY];
        const stopped = stored[BaixaStorage.KEYS.stop] === true || activeRun?.stopped === true;
        const automationActive = !stopped && Boolean(
          (activeRun && !activeRun.stopped) || (activeBatch && !activeBatch.finished)
        );
        sendResponse({
        ok: true,
        current: stored[BaixaStorage.KEYS.current] || null,
        history: stored[BaixaStorage.KEYS.history] || [],
        stopped,
        automationActive,
        mode: settings.mode,
        aiConfigured: Boolean(settings.apiKey),
        provider: settings.provider,
        aiConnection: stored.baixaAiConnectionStatus || null
        });
      }).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_OPTIONS") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    Promise.all([BaixaStorage.getSettings(), BaixaStorage.get([BaixaStorage.KEYS.history])])
      .then(([settings, stored]) => {
        const requestedProvider = message.provider === "groq" ? "groq" : message.provider === "gemini" ? "gemini" : settings.provider;
        const hasApiKey = Boolean(settings.apiKeys?.[requestedProvider] || (requestedProvider === "gemini" && settings.apiKey));
        sendResponse({
        ok: true,
        settings: {
          provider: requestedProvider,
          model: settings.model,
          temperature: settings.temperature,
          minimumConfidence: settings.minimumConfidence,
          mode: settings.mode
        },
        hasApiKey,
        history: stored[BaixaStorage.KEYS.history] || []
        });
      })
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "TEST_AI_API") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    BaixaStorage.getSettings().then(async current => {
      const provider = message.settings?.provider === "groq" ? "groq" : "gemini";
      const savedProviderKey = current.apiKeys?.[provider] || (provider === "gemini" ? current.apiKey : "");
      const apiKey = String(message.settings?.apiKey || savedProviderKey || "").trim();
      if (!apiKey) throw new Error("Informe e salve uma API Key antes de testar.");
      if (message.settings?.privacyConsent !== true) throw new Error("Confirme o aviso de privacidade antes de enviar o teste.");

      // Apenas dados sintéticos e públicos; nunca enviar dados de um chamado real neste teste.
      const sample = {
        tipoAbertura: "INICIAL",
        procedencia: "REATIVO",
        tipoIncidencia: "DADOS",
        cliente: "SEDUC - SECRETARIA DE EDUCAÇÃO",
        intragov: false,
        servicoAfetado: "Internet"
      };
      const result = await BaixaAIService.analyzeCase(sample, {
        provider,
        apiKey,
        model: String(message.settings?.model || current.model || (message.settings?.provider === "groq" ? "openai/gpt-oss-120b" : "gemini-3.8-flash")).trim(),
        temperature: Number(message.settings?.temperature ?? current.temperature)
      });
      if (!result.available) {
        const safeReason = String(result.reason || "Falha desconhecida.").split(apiKey).join("[chave ocultada]");
        throw new Error(safeReason);
      }
      return { provider: provider === "groq" ? "Groq Cloud" : "Gemini API", providerId: provider, model: String(message.settings?.model || current.model), structuredJson: true };
    }).then(async test => {
      const status = { connected: true, ...test, testedAt: new Date().toISOString(), message: "Conexão e resposta JSON validadas." };
      await BaixaStorage.set({ baixaAiConnectionStatus: status });
      sendResponse({ ok: true, test });
    }).catch(async error => {
      const provider = message.settings?.provider === "groq" ? "groq" : "gemini";
      const status = { connected: false, providerId: provider, provider: provider === "groq" ? "Groq Cloud" : "Gemini API", testedAt: new Date().toISOString(), message: error.message || "Não foi possível testar a API." };
      try { await BaixaStorage.set({ baixaAiConnectionStatus: status }); } catch { /* estado do teste é apenas indicativo */ }
      sendResponse({ ok: false, error: status.message });
    });
    return true;
  }

  if (message?.type === "SAVE_OPTIONS") {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const value = message.settings || {};
    BaixaStorage.getSettings().then(current => {
      const temperature = Number(value.temperature);
      const confidence = Number(value.minimumConfidence);
      const provider = value.provider === "groq" ? "groq" : "gemini";
      const settings = {
      provider,
      apiKeys: {
        ...(current.apiKeys || {}),
        ...(current.provider === "gemini" && current.apiKey && !current.apiKeys?.gemini ? { gemini: current.apiKey } : {}),
        [provider]: value.deleteApiKey
          ? ""
          : String(value.apiKey || "").trim() || (current.apiKeys?.[provider] || (current.provider === provider ? current.apiKey : ""))
      },
      model: String(value.model || (value.provider === "groq" ? "openai/gpt-oss-120b" : "gemini-3.8-flash")).trim(),
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : current.temperature,
      minimumConfidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : current.minimumConfidence,
      mode: value.mode === "automatic" ? "automatic" : "analysis"
      };
      return BaixaStorage.set({ [BaixaStorage.KEYS.settings]: settings });
    }).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(tabId => {
  activeRuns.get(tabId)?.controller.abort();
  activeRuns.delete(tabId);
  for (const batch of batchRuns.values()) {
    if (batch.ticketTabId === tabId && !batch.finished) {
      batch.ticketUncertain = true;
      void finishBatch(batch, `Fila pausada: a guia do ticket ${batch.sequence} foi fechada antes da confirmação.`, "error");
    } else if (batch.listTabId === tabId && !batch.finished) {
      batch.ticketUncertain = Boolean(batch.ticketTabId);
      void finishBatch(batch, `Fila da lista ${batch.listName} encerrada porque a guia da tabela foi fechada.`, "error");
    }
  }
  BaixaStorage.get("baixaActiveRun").then(stored => {
    if (stored.baixaActiveRun?.tabId === tabId) return BaixaStorage.set({ baixaActiveRun: null });
  }).catch(() => undefined);
});
