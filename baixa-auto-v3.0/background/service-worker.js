/* bundled: utils/helpers.js */
(function (root) {
  "use strict";

  const CASE_FIELDS = Object.freeze([
    "tipoAbertura", "procedencia", "tipoIncidencia", "cliente", "intragov", "servicoAfetado",
    "numeroChamado", "dataCriacao", "dataObjetivo", "dataReparo", "dataInicioSla", "paradaRelogio",
    "dataParadaRelogio", "acionamento", "codigoAcionamento"
  ]);

  function normalizeText(value) {
    return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function buildAIPayload(input = {}) {
    const intragovText = normalizeText(input.intragov);
    const intragov = typeof input.intragov === "boolean" ? input.intragov
      : ["sim", "marcado", "true", "1"].includes(intragovText) ? true
        : ["nao", "desmarcado", "false", "0"].includes(intragovText) ? false : null;
    return {
      tipoAbertura: String(input.tipoAbertura ?? "").trim(),
      procedencia: String(input.procedencia ?? "").trim(),
      tipoIncidencia: String(input.tipoIncidencia ?? "").trim(),
      cliente: String(input.cliente ?? "").trim(),
      intragov,
      servicoAfetado: String(input.servicoAfetado ?? "").trim()
    };
  }

  function caseFingerprint(input = {}) {
    return CASE_FIELDS.map(key => `${key}:${String(input[key] ?? "").trim()}`).join("|");
  }

  function escapeCsv(value) {
    const raw = String(value ?? "");
    const text = /^[\s\u0000-\u001f]*[=+@-]/.test(raw) ? `'${raw}` : raw;
    return `"${text.replace(/"/g, '""')}"`;
  }

  const VERSION = "3.1.0";
  const STOP_MESSAGE = "Automação interrompida pelo usuário.";
  const DEFAULT_MODELS = Object.freeze({ gemini: "gemini-3.8-flash", groq: "openai/gpt-oss-120b" });

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Espera até que predicate() devolva um valor verdadeiro. Respeita o pedido
  // de parada do usuário a cada ciclo e devolve false ao estourar o tempo.
  async function waitFor(predicate, timeout = 12000, shouldStop = () => false, pollMs = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error(STOP_MESSAGE);
      const value = predicate();
      if (value) return value;
      await sleep(pollMs);
    }
    return false;
  }

  const SUCCESS_RESULTS = Object.freeze(["TICKET LIBERADO", "GRAVAR BAIXA ACIONADO", "BAIXA REALIZADA"]);

  // Resumo do histórico para o painel de estatísticas das opções.
  function summarizeHistory(history) {
    const list = Array.isArray(history) ? history : [];
    const byResult = {};
    const byCode = {};
    const byDay = {};
    let success = 0;
    for (const item of list) {
      const result = String(item?.resultado || "SEM RESULTADO");
      byResult[result] = (byResult[result] || 0) + 1;
      const isSuccess = SUCCESS_RESULTS.includes(result);
      if (isSuccess) {
        success++;
        const code = String(item?.codigoBaixa || "—");
        byCode[code] = (byCode[code] || 0) + 1;
        const day = String(item?.dataHora || "").slice(0, 10);
        if (day) byDay[day] = (byDay[day] || 0) + 1;
      }
    }
    const total = list.length;
    return { total, success, failed: total - success, successRate: total ? success / total : 0, byResult, byCode, byDay };
  }

  // Filtro por texto livre (todos os campos) e por resultado exato.
  function filterHistory(history, { text = "", result = "" } = {}) {
    const needle = normalizeText(text);
    return (Array.isArray(history) ? history : []).filter(item => {
      if (result && String(item?.resultado || "") !== result) return false;
      if (!needle) return true;
      return normalizeText(Object.values(item || {}).join(" ")).includes(needle);
    });
  }

  // A chave de aprendizagem é um JSON: [clientePrioritario, abertura, procedência, incidência, intragov, serviço].
  function describeLearningKey(key) {
    try {
      const [client, opening, procedure, incidence, intragov, service] = JSON.parse(key);
      return {
        cliente: client === "cliente-prioritario-2A011" ? "Cliente prioritário" : "Outro cliente",
        tipoAbertura: opening || "—", procedencia: procedure || "—", tipoIncidencia: incidence || "—",
        intragov: intragov === "true" ? "Sim" : intragov === "false" ? "Não" : "—", servicoAfetado: service || "—"
      };
    } catch { return null; }
  }

  const api = { VERSION, SUCCESS_RESULTS, summarizeHistory, filterHistory, describeLearningKey, STOP_MESSAGE, DEFAULT_MODELS, CASE_FIELDS, normalizeText, buildAIPayload, caseFingerprint, escapeCsv, sleep, waitFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaHelpers = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: automation/navigation.js */
(function (root) {
  "use strict";
  // As telas legadas do SIGITM atualizam o conteúdo de forma assíncrona. A automação
  // não deve tratar o pequeno ícone central de carregamento como bloqueio da etapa.

  function documents() {
    const result = [];
    const queue = [document];
    const seen = new Set();
    while (queue.length) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      result.push(current);
      for (const frame of current.querySelectorAll("iframe, frame")) {
        try { if (frame.contentDocument) queue.push(frame.contentDocument); } catch { /* cross-origin: fields remain unidentified */ }
      }
    }
    return result;
  }

  function visible(element) {
    if (!element || element.hidden) return false;
    const style = getComputedStyleSafe(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0)) return false;
    if (style?.pointerEvents === "none" && (style.position === "fixed" || style.position === "absolute")) return false;
    const rects = element.getClientRects?.();
    if (rects?.length) {
      const rect = element.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) return false;
      return true;
    }
    return Boolean(element.offsetParent);
  }

  function normalize(value) { return root.BaixaHelpers.normalizeText(value); }
  function textOf(element) { return String(element?.innerText || element?.textContent || "").trim(); }

  function loadingIndicators() {
    const selectors = "[aria-busy='true'], .loading, .loader, .spinner, .blockUI, .block-ui, .ui-blockui, .ajax-loader, [id*='loading' i], [class*='loading' i], [id*='spinner' i], [class*='spinner' i], img[src*='loading' i], img[src*='spinner' i], img[src*='ajax' i]";
    return documents().flatMap(doc => [...doc.querySelectorAll(selectors)])
      .filter(isBlockingLoadingIndicator);
  }

  function isBlockingLoadingIndicator(element) {
    if (!visible(element)) return false;
    const style = getComputedStyleSafe(element);
    const rect = element.getBoundingClientRect?.();
    if (!style || !rect) return false;
    const width = Math.max(0, Number(rect.width) || 0);
    const height = Math.max(0, Number(rect.height) || 0);
    const area = width * height;
    const metadata = normalize([
      element.id, element.className, element.getAttribute?.("src"), element.getAttribute?.("alt"),
      element.getAttribute?.("aria-label")
    ].filter(Boolean).join(" "));
    const explicitBlock = element.matches?.("[aria-busy='true'], .blockUI, .block-ui, .ui-blockui");
    if (explicitBlock) return true;

    // O SIGITM mostra um globo pequeno enquanto troca de aba/grava uma ação.
    // Ele é feedback visual, não um bloqueio de tela: nunca faça a fila esperar
    // por esse tipo de indicador isolado.
    const isSmallStandalone = width > 0 && height > 0 && width <= 140 && height <= 140 &&
      /loading|loader|spinner|ajax|aguarde|process/.test(metadata) &&
      !/(overlay|blockui|modal|mask)/.test(metadata);
    if (isSmallStandalone) return false;

    const viewport = element.ownerDocument?.defaultView;
    const viewportWidth = Number(viewport?.innerWidth) || 1000;
    const viewportHeight = Number(viewport?.innerHeight) || 700;
    const fixedOrAbsolute = style.position === "fixed" || style.position === "absolute";
    const coversScreen = width >= viewportWidth * 0.45 || height >= viewportHeight * 0.45 || area >= viewportWidth * viewportHeight * 0.18;
    const imageLoader = element.matches?.("img") && /loading|spinner|ajax|process|aguarde/.test(metadata) && (width >= 120 || height >= 120);
    const genericLoader = /loading|loader|spinner|ajax/.test(metadata) && (coversScreen || (fixedOrAbsolute && area >= 16000));
    return imageLoader || genericLoader;
  }

  function getComputedStyleSafe(element) {
    try { return element.ownerDocument.defaultView.getComputedStyle(element); }
    catch { return null; }
  }

  async function waitForLoadingToFinish(shouldStop = () => false, timeout = 900) {
    const end = Date.now() + timeout;
    while (loadingIndicators().length) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      if (Date.now() >= end) return false;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return true;
  }

  function controlsFor(aliases, editableOnly = false) {
    const wanted = new Set(aliases.map(normalize));
    const found = new Set();
    for (const doc of documents()) {
      for (const control of doc.querySelectorAll("input, select, textarea")) {
        if (!visible(control) || control.type === "hidden") continue;
        const metadata = [control.id, control.name, control.title, control.getAttribute("aria-label"),
          ...(control.labels ? [...control.labels].map(textOf) : [])].map(normalize);
        if (metadata.some(value => wanted.has(value))) found.add(control);
      }
      for (const label of doc.querySelectorAll("label, th, td, span, div")) {
        if (!visible(label) || label.children.length > 4 || textOf(label).length > 90 || !wanted.has(normalize(textOf(label).replace(/:$/, "")))) continue;
        if (label.tagName === "LABEL" && label.htmlFor) {
          const associated = doc.getElementById(label.htmlFor);
          if (associated && visible(associated) && associated.type !== "hidden") found.add(associated);
        }
        const cell = label.matches("td, th") ? label : label.closest("td, th");
        if (cell) {
          for (let sibling = cell.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
            const controls = [...sibling.querySelectorAll("input, select, textarea")].filter(item => visible(item) && item.type !== "hidden");
            if (controls.length) { controls.forEach(item => found.add(item)); break; }
          }
        }
        const row = label.closest("tr, [role='row'], .form-group, fieldset") || label.parentElement;
        const candidates = [...(row?.querySelectorAll("input, select, textarea") || [])].filter(item => visible(item) && item.type !== "hidden");
        if (candidates.length === 1) found.add(candidates[0]);
      }
    }
    const controls = [...found];
    return editableOnly ? controls.filter(control => !control.disabled && !control.readOnly) : controls;
  }

  function valueOf(control) {
    if (!control || !visible(control)) return "";
    if (control.type === "checkbox" || control.type === "radio") return control.checked ? "Sim" : "Não";
    if (control.tagName === "SELECT") return control.selectedOptions?.[0]?.textContent?.trim() || control.value || "";
    return String(control.value ?? "").trim();
  }

  function readField(aliases) {
    const controls = controlsFor(aliases);
    if (controls.length === 1) return valueOf(controls[0]);
    if (controls.length > 1) return "";
    const wanted = new Set(aliases.map(normalize));
    for (const doc of documents()) {
      for (const node of doc.querySelectorAll("label, th, td, span, div")) {
        if (!visible(node) || node.children.length > 3) continue;
        const lines = textOf(node).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const inline = lines[0]?.match(/^([^:]{2,80}):\s*(.+)$/);
        if (inline && wanted.has(normalize(inline[1]))) return inline[2].trim();
        if (lines.length > 1 && wanted.has(normalize(lines[0].replace(/:$/, "")))) return lines[1];
      }
    }
    return "";
  }

  function readIntragov() {
    // O SIGITM exibe Intragov como checkbox ao lado do texto, em vez de um
    // campo convencional. Quando não existir, ele é tratado como desmarcado.
    for (const doc of documents()) {
      const checkboxes = [...doc.querySelectorAll("input[type='checkbox']")]
        .filter(visible);
      for (const control of checkboxes) {
        const metadata = normalize([
          control.id, control.name, control.title, control.getAttribute("aria-label"),
          ...(control.labels ? [...control.labels].map(textOf) : [])
        ].filter(Boolean).join(" "));
        if (metadata.includes("intragov")) return control.checked ? "Sim" : "Não";
      }
      for (const label of doc.querySelectorAll("label, th, td, span, div")) {
        if (!visible(label) || normalize(textOf(label).replace(/:$/, "")) !== "intragov") continue;
        const labelRect = label.getBoundingClientRect?.();
        if (!labelRect) continue;
        const nearby = checkboxes.map(control => ({ control, rect: control.getBoundingClientRect?.() }))
          .filter(item => item.rect && item.rect.left >= labelRect.right - 12 &&
            Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) <= 34)
          .sort((first, second) => first.rect.left - second.rect.left);
        if (nearby.length) return nearby[0].control.checked ? "Sim" : "Não";
      }
    }
    return "Não";
  }

  function resolveActionState(foundAction, rowText) {
    if (!foundAction) return { acionamento: "Não", codigoAcionamento: "" };
    const status = normalize(rowText);
    if (/\bativo\b|\bativa\b|\baberto\b/.test(status)) return { acionamento: "Sim", codigoAcionamento: "6Z036" };
    if (/\bbaixado\b|\bfechado\b|\bencerrado\b|\binativo\b/.test(status)) return { acionamento: "Não", codigoAcionamento: "" };
    return { acionamento: "", codigoAcionamento: "" };
  }

  function findTabCandidates(name) {
    const target = normalize(name);
    const matches = [];
    for (const doc of documents()) {
      const actionableSelector = "a, button, [role='tab'], input[type='button'], input[type='submit'], [onclick], [tabindex]";
      const actionable = [...doc.querySelectorAll(actionableSelector)].filter(tab => {
        if (!visible(tab) || tab.disabled || tab.getAttribute("aria-disabled") === "true") return false;
        return normalize(textOf(tab) || tab.value || tab.getAttribute("aria-label")) === target;
      });
      if (actionable.length) {
        matches.push(...actionable);
        continue;
      }

      // O SIGITM usa abas antigas desenhadas como células de tabela; elas podem
      // receber o clique diretamente ou delegá-lo ao elemento pai.
      for (const label of doc.querySelectorAll("td, th, li, span, div")) {
        if (!visible(label) || normalize(textOf(label)) !== target) continue;
        const cell = label.matches("td, th") ? label : label.closest("td, th");
        const tabContainer = label.closest("[role='tab'], [class*='tab' i], [id*='tab' i], [class*='aba' i], [id*='aba' i], li");
        const candidate = cell || (tabContainer && normalize(textOf(tabContainer)) === target ? tabContainer : label);
        if (visible(candidate) && !candidate.disabled) matches.push(candidate);
      }
    }
    return [...new Set(matches)].filter(candidate => !matches.some(other =>
      other !== candidate && candidate.contains?.(other) && normalize(textOf(other)) === target));
  }

  function tabLooksActive(element) {
    if (!element) return false;
    const ariaSelected = String(element.getAttribute?.("aria-selected") || "").toLowerCase();
    if (ariaSelected === "true") return true;
    const metadata = normalize([
      element.className,
      element.getAttribute?.("data-state"),
      element.getAttribute?.("data-active"),
      element.getAttribute?.("aria-current"),
      element.getAttribute?.("title")
    ].filter(Boolean).join(" "));
    return /(^| )(active|ativo|selected|selecionado|current|atual)( |$)/.test(metadata);
  }

  function certificationControlsVisible() {
    return documents().some(doc => [...doc.querySelectorAll("select, input, textarea")].some(control =>
      visible(control) && /selecione (um|o) status|selecionar um status/i.test(textOf(control.selectedOptions?.[0] || control))
    ));
  }

  function tabContentHint(name) {
    const target = normalize(name);
    const bodyText = documents().map(doc => normalize(doc.body?.innerText || "")).join(" ");
    if (target === "cliente") return /cliente|servico afetado/.test(bodyText);
    if (target === "definicao") return /tipo de abertura|procedencia|tipo de incidencia/.test(bodyText);
    if (target === "data") return /data criacao|data objetivo|data de reparo|inicio do sla/.test(bodyText);
    if (target === "acionamento") return /6z036|codigo do acionamento|acionamento/.test(bodyText);
    if (target === "certificacao") return /certificacao|selecione um status|selecionar um status/.test(bodyText) || certificationControlsVisible();
    if (target === "encerramento") return /codigo completo da baixa|data de reparo|descricao|tecnico/.test(bodyText);
    return false;
  }

  async function waitForTabActivation(name, clickedElement, shouldStop = () => false, timeout = 1600) {
    const target = normalize(name);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      const candidates = findTabCandidates(name);
      if (candidates.some(tabLooksActive)) return true;
      if (target === "certificacao" && certificationControlsVisible()) return true;
      if (tabContentHint(name) && candidates.length) return true;
      // Se a aba já foi localizada e o SIGITM está apenas mostrando o pequeno
      // indicador central, não espere o loader desaparecer: a próxima leitura
      // pode começar assim que o conteúdo estiver disponível.
      if (candidates.length === 1 && candidates[0] !== clickedElement) return true;
      await new Promise(resolve => setTimeout(resolve, 35));
    }
    return false;
  }

  async function clickTab(name, shouldStop = () => false) {
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    const deadline = Date.now() + 3200;
    let unique = [];
    while (Date.now() < deadline) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      unique = findTabCandidates(name);
      if (unique.length === 1) break;
      if (unique.length > 1) {
        // Prefira a aba visivelmente ativa/real no caso raro de uma cópia do
        // cabeçalho existir em outro contêiner.
        const visibleActive = unique.filter(tabLooksActive);
        if (visibleActive.length === 1) { unique = visibleActive; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    if (unique.length !== 1) throw new Error(`Aba ${name} ${unique.length ? "ambígua" : "não encontrada"}.`);
    const clicked = unique[0];
    clicked.focus?.();
    clicked.click();
    const activated = await waitForTabActivation(name, clicked, shouldStop);
    if (!activated && normalize(name) === "certificacao") {
      throw new Error("Aba Certificação foi localizada, mas o SIGITM não confirmou a abertura do conteúdo da aba.");
    }
    return !shouldStop();
  }

  async function readCase(shouldStop = () => false, onTab = () => {}) {
    onTab("Cliente");
    if (!await clickTab("Cliente", shouldStop)) throw new Error("Automação interrompida.");
    const cliente = readField(["Cliente"]);
    const servicoAfetado = readField(["Serviço Afetado", "Servico Afetado"]);

    onTab("Definição");
    if (!await clickTab("Definição", shouldStop)) throw new Error("Automação interrompida.");
    const ticket = readField(["Nº tíquete", "Número do chamado", "Número do tíquete", "Tíquete", "Sequência", "BD"]);
    const data = { numeroChamado: String(ticket).match(/\d{5,20}/)?.[0] || "" };
    data.tipoAbertura = readField(["Tipo de Abertura", "Tipo abertura", "Tipo Abertura"]);
    data.procedencia = readField(["Procedência", "Procedencia"]);
    data.tipoIncidencia = readField(["Tipo de Incidência", "Tipo de Incidencia", "Tipo incidência", "Tipo incidencia"]);
    data.cliente = cliente || readField(["Cliente"]);
    data.intragov = readIntragov();
    data.servicoAfetado = servicoAfetado || readField(["Serviço Afetado", "Servico Afetado"]);

    onTab("Data");
    if (!await clickTab("Data", shouldStop)) throw new Error("Automação interrompida.");
    data.dataCriacao = readField(["Data Criação", "Data Criacao", "Data de Criação", "Data de Criacao"]);
    data.dataObjetivo = readField(["Data Objetivo"]);
    // A data já existente na aba Data é o limite superior. O Encerramento usa
    // uma data intermediária, calculada posteriormente, e não a copia.
    data.dataReparoOriginal = readField(["Data de Reparo", "Data Reparo"]);
    data.dataReparo = "";
    data.dataInicioSla = readField(["Início do SLA", "Inicio do SLA", "Data de Início do SLA", "Data de Inicio do SLA"]);
    data.paradaRelogio = readField(["Parada de Relógio"]);
    data.dataParadaRelogio = readField(["Data da Parada de Relógio", "Data da Parada do Relógio", "Data Parada de Relógio", "Data Pausa", "Data/Hora da Pausa"]);

    onTab("Acionamento");
    if (!await clickTab("Acionamento", shouldStop)) throw new Error("Automação interrompida.");
    const actionText = documents().map(doc => textOf(doc.body)).join("\n");
    const actionRows = documents().flatMap(doc => [...doc.querySelectorAll("tr, [role='row'], li")])
      .filter(row => visible(row) && /\b6Z036\b/i.test(textOf(row)))
      .sort((a, b) => textOf(a).length - textOf(b).length);
    const actionRowText = normalize(textOf(actionRows[0]));
    const actionCode = readField(["Código do Acionamento", "Código Completo do Acionamento"]);
    const foundAction = /\b6Z036\b/i.test(`${actionCode} ${actionText}`);
    Object.assign(data, resolveActionState(foundAction, actionRowText));
    return data;
  }

  const api = { documents, visible, normalize, textOf, controlsFor, valueOf, readField, readIntragov, resolveActionState, loadingIndicators, waitForLoadingToFinish, findTabCandidates, tabLooksActive, clickTab, readCase };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: automation/batch-handler.js */
(function (root) {
  "use strict";

  const LISTS = Object.freeze({
    "138550": "Ativos e Parados",
    "95803": "Validação Massiva"
  });

  function listIdFromUrl(url) {
    try { return new URL(url).searchParams.get("idConsulta") || ""; }
    catch { return ""; }
  }

  function listName(url) {
    return LISTS[listIdFromUrl(url)] || "";
  }

  function normalize(value) { return root.BaixaHelpers.normalizeText(value); }

  function sequenceHeaderIndex(cells) {
    return cells.findIndex(cell => {
      const label = normalize([root.BaixaNavigation.textOf(cell), cell.getAttribute?.("aria-label"), cell.getAttribute?.("title")]
        .filter(Boolean).join(" ").replace(/[↕↔↑↓⇅⇵▲▼]/g, " "));
      return label === "seq" || label.startsWith("seq ");
    });
  }

  function sequenceNumber(cell) {
    return normalize(root.BaixaNavigation.textOf(cell)).match(/\b\d{5,20}\b/)?.[0] || "";
  }

  function readListState(documents = root.BaixaNavigation.documents()) {
    const tickets = new Map();
    let explicitEmpty = false;
    for (const doc of documents) {
      const bodyText = normalize(doc.body?.innerText || doc.body?.textContent || "");
      if (/\bzero registros\b|\bnenhum registro\b|\bnenhum chamado\b|\b0 registros\b|\bnao existem registros\b|\bconsulta sem registros\b/.test(bodyText)) explicitEmpty = true;
      const tables = [...doc.querySelectorAll("table")];
      for (const table of tables) {
        const rows = [...table.querySelectorAll("tr")];
        const headerIndex = rows.findIndex(row => sequenceHeaderIndex([...row.querySelectorAll("th, td")]) >= 0);
        if (headerIndex < 0) continue;
        const headers = [...rows[headerIndex].querySelectorAll("th, td")];
        const sequenceIndex = sequenceHeaderIndex(headers);
        for (const row of rows.slice(headerIndex + 1)) {
          const cells = [...row.querySelectorAll("th, td")];
          const sequenceCell = cells[sequenceIndex];
          if (!sequenceCell) continue;
          const sequence = sequenceNumber(sequenceCell);
          if (sequence && root.BaixaNavigation.visible(sequenceCell)) tickets.set(sequence, sequence);
        }
      }
    }
    const recordCounts = documents.flatMap(doc => [...String(doc.body?.innerText || doc.body?.textContent || "").matchAll(/registros\s*:\s*(\d+)\s*de\s*(\d+)/gi)])
      .map(match => ({ shown: Number(match[1]), total: Number(match[2]) }));
    const recordCount = recordCounts.find(item => item.total > 0) || recordCounts[0] || null;
    const empty = explicitEmpty || Boolean(recordCount && recordCount.total === 0);
    return { tickets: [...tickets.keys()], empty, recordCount };
  }

  const api = { LISTS, listIdFromUrl, listName, sequenceHeaderIndex, sequenceNumber, readListState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaBatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: storage/storage.js */
(function (root) {
  "use strict";

  const KEYS = Object.freeze({ settings: "baixaSettings", current: "baixaCurrentResult", history: "baixaHistory", stop: "baixaStopRequested" });
  let historyWriteQueue = Promise.resolve();
  let codeLearningWriteQueue = Promise.resolve();

  function get(keys) {
    return new Promise((resolve, reject) => chrome.storage.local.get(keys, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    }));
  }

  function set(values) {
    return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    }));
  }

  async function getSettings() {
    const result = await get(KEYS.settings);
    const provider = result[KEYS.settings]?.provider === "groq" ? "groq" : "gemini";
    const apiKeys = result[KEYS.settings]?.apiKeys || {};
    return {
      provider,
      apiKey: apiKeys[provider] || (provider === "gemini" ? result[KEYS.settings]?.apiKey || "" : ""),
      apiKeys,
      model: result[KEYS.settings]?.model || root.BaixaHelpers.DEFAULT_MODELS[provider],
      temperature: Number(result[KEYS.settings]?.temperature ?? 0),
      minimumConfidence: Number(result[KEYS.settings]?.minimumConfidence ?? 0.85),
      mode: result[KEYS.settings]?.mode === "automatic" ? "automatic" : "analysis"
    };
  }

  function addHistory(record) {
    const task = historyWriteQueue.then(async () => {
      const stored = await get(KEYS.history);
      const history = Array.isArray(stored[KEYS.history]) ? stored[KEYS.history] : [];
      history.push({ ...record, dataHora: new Date().toISOString() });
      await set({ [KEYS.history]: history.slice(-500) });
      return history.length;
    });
    historyWriteQueue = task.catch(() => undefined);
    return task;
  }

  function codeLearningKey(data) {
    const normalize = value => root.BaixaHelpers.normalizeText(value);
    const fields = root.BaixaRules.canonicalize(data || {});
    const automaticClientCode = root.BaixaRules.automaticCodeForClient(fields.cliente);
    return JSON.stringify([
      automaticClientCode === "2A011" ? "cliente-prioritario-2A011" : "outro cliente", normalize(fields.tipoAbertura), normalize(fields.procedencia),
      normalize(fields.tipoIncidencia), fields.intragov === null ? "" : String(fields.intragov), normalize(fields.servicoAfetado)
    ]);
  }

  async function getLearnedCode(data) {
    const stored = await get("baixaCodeLearning");
    const entry = stored.baixaCodeLearning?.[codeLearningKey(data)];
    return entry && root.BaixaRules.CODES.includes(entry.codigoBaixa) ? entry : null;
  }

  function saveLearnedCode(data, code) {
    if (!root.BaixaRules.CODES.includes(code)) return Promise.reject(new Error("Código de baixa fora da lista permitida."));
    const task = codeLearningWriteQueue.then(async () => {
      const stored = await get("baixaCodeLearning");
      const learning = stored.baixaCodeLearning && typeof stored.baixaCodeLearning === "object"
        ? { ...stored.baixaCodeLearning } : {};
      const key = codeLearningKey(data);
      const previous = learning[key];
      learning[key] = {
        codigoBaixa: code,
        ocorrencias: Number(previous?.ocorrencias || 0) + 1,
        updatedAt: new Date().toISOString()
      };
      const entries = Object.entries(learning).sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || "")));
      await set({ baixaCodeLearning: Object.fromEntries(entries.slice(0, 2000)) });
      return learning[key];
    });
    codeLearningWriteQueue = task.catch(() => undefined);
    return task;
  }

  function enqueueLearningWrite(work) {
    const task = codeLearningWriteQueue.then(work);
    codeLearningWriteQueue = task.catch(() => undefined);
    return task;
  }

  async function listLearnedCodes() {
    const stored = await get("baixaCodeLearning");
    const learning = stored.baixaCodeLearning && typeof stored.baixaCodeLearning === "object" ? stored.baixaCodeLearning : {};
    return Object.entries(learning)
      .filter(([, entry]) => root.BaixaRules.CODES.includes(entry?.codigoBaixa))
      .map(([key, entry]) => ({ key, codigoBaixa: entry.codigoBaixa, ocorrencias: Number(entry.ocorrencias) || 1, updatedAt: String(entry.updatedAt || "") }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function deleteLearnedCode(key) {
    return enqueueLearningWrite(async () => {
      const stored = await get("baixaCodeLearning");
      const learning = { ...(stored.baixaCodeLearning || {}) };
      const existed = Object.prototype.hasOwnProperty.call(learning, key);
      delete learning[key];
      await set({ baixaCodeLearning: learning });
      return existed;
    });
  }

  function clearLearnedCodes() {
    return enqueueLearningWrite(async () => {
      await set({ baixaCodeLearning: {} });
      return true;
    });
  }

  // Importa um backup (lista de { key, codigoBaixa, ocorrencias, updatedAt }).
  // Entradas inválidas são descartadas; a mais recente prevalece em conflitos.
  function importLearnedCodes(entries) {
    if (!Array.isArray(entries)) return Promise.reject(new Error("Backup inválido: esperado uma lista de códigos aprendidos."));
    return enqueueLearningWrite(async () => {
      const stored = await get("baixaCodeLearning");
      const learning = { ...(stored.baixaCodeLearning || {}) };
      let imported = 0;
      let ignored = 0;
      for (const entry of entries.slice(0, 2000)) {
        const key = typeof entry?.key === "string" ? entry.key : "";
        let parsed = null;
        try { parsed = JSON.parse(key); } catch { /* chave inválida */ }
        if (!key || key.length > 600 || !Array.isArray(parsed) || parsed.length !== 6 || !root.BaixaRules.CODES.includes(entry.codigoBaixa)) { ignored++; continue; }
        const updatedAt = Number.isFinite(Date.parse(entry.updatedAt)) ? new Date(entry.updatedAt).toISOString() : new Date().toISOString();
        const current = learning[key];
        if (current && String(current.updatedAt || "") >= updatedAt) { ignored++; continue; }
        learning[key] = { codigoBaixa: entry.codigoBaixa, ocorrencias: Math.max(1, Math.min(1e6, Math.floor(Number(entry.ocorrencias) || 1))), updatedAt };
        imported++;
      }
      const kept = Object.entries(learning).sort((a, b) => String(b[1]?.updatedAt || "").localeCompare(String(a[1]?.updatedAt || ""))).slice(0, 2000);
      await set({ baixaCodeLearning: Object.fromEntries(kept) });
      return { imported, ignored };
    });
  }

  const api = { KEYS, get, set, getSettings, addHistory, codeLearningKey, getLearnedCode, saveLearnedCode, listLearnedCodes, deleteLearnedCode, clearLearnedCodes, importLearnedCodes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaStorage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: rules/baixa-rules.js */
(function (root) {
  "use strict";

  const CODES = Object.freeze(["57033", "6Y200", "2A082", "2A011"]);
  const SAI = "sai servico de acesso a internet";
  const DIAGNOSIS_STANDARD = "00000017 Testado OK";
  const DIAGNOSIS_DDR = "00000032 Testado OK";

  function automaticCodeForClient(clientName) {
    const client = root.BaixaHelpers.normalizeText(clientName);
    const hasEducationDepartment = client.includes("secretaria") && client.includes("educacao");
    const hasEducationDevelopmentFund = /(^| )(fundo|fundacao)( |$)/.test(client) && client.includes("desenvolvimento") && client.includes("educacao");
    const hasSeducAcronym = /(^| )seduc( |$)/.test(client);
    const hasFedAcronym = /(^| )fed( |$)/.test(client);
    if (hasEducationDepartment || hasEducationDevelopmentFund || hasSeducAcronym || hasFedAcronym) return "2A011";
    return "";
  }

  function canonicalize(input = {}) {
    const norm = root.BaixaHelpers.normalizeText;
    const openingText = norm(input.tipoAbertura);
    const procedureText = norm(input.procedencia);
    const incidenceText = norm(input.tipoIncidencia);
    const serviceText = norm(input.servicoAfetado);
    const boolIntragov = typeof input.intragov === "boolean"
      ? input.intragov
      : ["sim", "marcado", "true", "1"].includes(norm(input.intragov))
        ? true
        : ["nao", "desmarcado", "false", "0"].includes(norm(input.intragov)) ? false : null;

    const opening = new Map([
      ["inicial", "INICIAL"],
      ["repetida", "REPETIDA"],
      ["repetido", "REPETIDA"],
      ["repetido 7 dias", "REPETIDA 7 DIAS"],
      ["repetida 7 dias", "REPETIDA 7 DIAS"],
      ["repetido 30 dias", "REPETIDA 30 DIAS"],
      ["repetida 30 dias", "REPETIDA 30 DIAS"]
    ]).get(openingText) || "";
    const procedure = new Map([["proativo", "PROATIVO"], ["reativo", "REATIVO"], ["preventivo", "PREVENTIVO"]]).get(procedureText) || "";
    const incidence = new Map([["dados", "DADOS"], ["convergente", "CONVERGENTE"], ["ddr", "DDR"]]).get(incidenceText) || "";
    const service = serviceText === SAI ? "SAI - Serviço de Acesso à Internet" : (String(input.servicoAfetado ?? "").trim());

    return {
      tipoAbertura: opening,
      procedencia: procedure,
      tipoIncidencia: incidence,
      cliente: String(input.cliente ?? "").trim(),
      intragov: boolIntragov,
      servicoAfetado: service
    };
  }

  function decide(input = {}) {
    const fields = canonicalize(input);
    const missing = [];
    const automaticClientCode = automaticCodeForClient(fields.cliente);
    if (automaticClientCode) {
      return result(automaticClientCode, "Cliente SEDUC/FED (sem perguntar)", fields, []);
    }

    // DDR é a segunda regra da pirâmide e determina 57033 mesmo com Intragov
    // marcado ou com campos de abertura/procedência ausentes.
    if (fields.tipoIncidencia === "DDR") {
      return result("57033", "Incidência DDR (independente dos demais campos)", fields, []);
    }

    // Fora de SEDUC/FED e DDR, Intragov marcado sempre usa 6Y200. O serviço
    // afetado não restringe mais esta regra.
    if (fields.intragov === true) {
      return result("6Y200", "Intragov marcado (independente dos demais campos)", fields, []);
    }

    // Para as combinações restantes, a incidência precisa estar identificada
    // antes de aplicar abertura/procedência: um DDR não informado não pode ser
    // confundido com uma combinação comum.
    if (!fields.tipoIncidencia) missing.push("Tipo de Incidência");
    if (missing.length) return blocked(`Dados necessários não identificados: ${[...new Set(missing)].join(", ")}.`, fields);

    const repeated = ["REPETIDA", "REPETIDA 7 DIAS", "REPETIDA 30 DIAS"].includes(fields.tipoAbertura);
    const is2A011Combination = (fields.tipoAbertura === "INICIAL" && ["PREVENTIVO", "REATIVO", "PROATIVO"].includes(fields.procedencia)) ||
      (repeated && fields.procedencia === "REATIVO");

    if (repeated && fields.procedencia === "PROATIVO") {
      return result("2A082", "Repetida + Proativo (prioridade 3)", fields, []);
    }
    if (is2A011Combination) {
      return result("2A011", `${fields.tipoAbertura} + ${fields.procedencia}`, fields, []);
    }
    if (!fields.tipoAbertura) missing.push("Tipo de Abertura");
    if (!fields.procedencia) missing.push("Procedência");
    if (missing.length) return blocked(`Dados necessários não identificados: ${[...new Set(missing)].join(", ")}.`, fields);
    return blocked("Regra não identificada para esta combinação.", fields);
  }

  function result(code, reason, fields, missing) {
    return {
      allowed: true,
      codigoBaixa: code,
      diagnostico: fields.tipoIncidencia === "DDR" ? DIAGNOSIS_DDR : DIAGNOSIS_STANDARD,
      motivo: reason,
      normalizedFields: fields,
      missing,
      confidence: 1
    };
  }

  function blocked(reason, fields = {}) {
    return { allowed: false, codigoBaixa: "", diagnostico: "", motivo: reason, normalizedFields: fields, missing: [], confidence: 0 };
  }

  const api = { CODES, DIAGNOSIS_STANDARD, DIAGNOSIS_DDR, canonicalize, automaticCodeForClient, decide };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: rules/validation.js */
(function (root) {
  "use strict";

  function compareAIWithRules(ai, deterministic, minimumConfidence = 0.85) {
    if (!deterministic?.allowed) return { allowed: false, status: "BLOQUEADO", reason: deterministic?.motivo || "Regra não identificada." };
    if (!ai || ai.available === false) {
      return {
        allowed: true,
        status: "FALLBACK DETERMINÍSTICO",
        reason: ai?.reason || "IA indisponível; decisão obtida somente pelo motor determinístico.",
        confidence: null,
        provider: "Motor determinístico"
      };
    }
    const verdict = ai.decision;
    if (!verdict || verdict.podeExecutar !== true || verdict.codigoBaixa !== deterministic.codigoBaixa || verdict.diagnostico !== deterministic.diagnostico) {
      return {
        allowed: false,
        status: "DIVERGÊNCIA IA × REGRAS",
        reason: "Divergência entre IA e regras do sistema. Baixa bloqueada para segurança.",
        confidence: verdict?.confianca ?? null,
        provider: ai.provider || "IA"
      };
    }
    const expectedFields = deterministic.normalizedFields || {};
    const aiFields = verdict.normalizedFields || {};
    const fieldMismatch = Object.keys(expectedFields).some(key => key === "intragov"
      ? aiFields[key] !== expectedFields[key]
      : root.BaixaHelpers.normalizeText(aiFields[key]) !== root.BaixaHelpers.normalizeText(expectedFields[key]));
    if (fieldMismatch) {
      return {
        allowed: false,
        status: "DIVERGÊNCIA IA × REGRAS",
        reason: "A interpretação de campos da IA diverge dos valores normalizados localmente. Baixa bloqueada para segurança.",
        confidence: verdict.confianca,
        provider: ai.provider || "IA"
      };
    }
    if (verdict.confianca < minimumConfidence) {
      return { allowed: false, status: "BLOQUEADO", reason: "Confiança da IA abaixo do limite configurado.", confidence: verdict.confianca, provider: ai.provider };
    }
    return { allowed: true, status: "VALIDADO IA × REGRAS", reason: verdict.motivo, confidence: verdict.confianca, provider: ai.provider };
  }

  const api = { compareAIWithRules };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaValidation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: ai/ai-schema.js */
(function (root) {
  "use strict";

  const codes = ["", "57033", "6Y200", "2A082", "2A011"];
  const diagnoses = ["", "00000017 Testado OK", "00000032 Testado OK"];
  const openings = ["", "INICIAL", "REPETIDA 7 DIAS", "REPETIDA 30 DIAS"];
  const procedures = ["", "PROATIVO", "REATIVO", "PREVENTIVO"];
  const incidences = ["", "DADOS", "CONVERGENTE", "DDR"];
  const outputSchema = Object.freeze({
    type: "OBJECT",
    additionalProperties: false,
    properties: {
      codigoBaixa: { type: "STRING", enum: codes },
      diagnostico: { type: "STRING", enum: diagnoses },
      motivo: { type: "STRING" },
      confianca: { type: "NUMBER" },
      podeExecutar: { type: "BOOLEAN" },
      normalizedFields: {
        type: "OBJECT",
        additionalProperties: false,
        properties: {
          tipoAbertura: { type: "STRING", enum: openings },
          procedencia: { type: "STRING", enum: procedures },
          tipoIncidencia: { type: "STRING", enum: incidences },
          cliente: { type: "STRING" },
          intragov: { type: "BOOLEAN" },
          servicoAfetado: { type: "STRING" }
        },
        required: ["tipoAbertura", "procedencia", "tipoIncidencia", "cliente", "intragov", "servicoAfetado"]
      }
    },
    required: ["codigoBaixa", "diagnostico", "motivo", "confianca", "podeExecutar", "normalizedFields"]
  });

  function validateDecision(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resposta da IA não é um objeto JSON.");
    if (!codes.includes(value.codigoBaixa) || !diagnoses.includes(value.diagnostico)) throw new Error("Código ou diagnóstico fora da lista permitida.");
    if (typeof value.motivo !== "string" || value.motivo.length > 300) throw new Error("Motivo inválido.");
    if (typeof value.confianca !== "number" || !Number.isFinite(value.confianca) || value.confianca < 0 || value.confianca > 1) throw new Error("Confiança inválida.");
    if (typeof value.podeExecutar !== "boolean") throw new Error("Campo podeExecutar inválido.");
    const fields = value.normalizedFields;
    if (!fields || !openings.includes(fields.tipoAbertura) || !procedures.includes(fields.procedencia) || !incidences.includes(fields.tipoIncidencia) ||
      typeof fields.cliente !== "string" || typeof fields.intragov !== "boolean" || typeof fields.servicoAfetado !== "string") {
      throw new Error("Campos normalizados pela IA fora do schema permitido.");
    }
    return {
      codigoBaixa: value.codigoBaixa,
      diagnostico: value.diagnostico,
      motivo: value.motivo,
      confianca: value.confianca,
      podeExecutar: value.podeExecutar,
      normalizedFields: fields
    };
  }

  const api = { outputSchema, validateDecision };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAISchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: ai/ai-provider.js */
(function (root) {
  "use strict";

  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
  const CLASSIFICATION_INSTRUCTIONS = [
    "Sua única tarefa é classificar os campos do chamado e retornar o código e diagnóstico no JSON. Você não controla o navegador, não clica em abas, botões, popups ou lupa; a extensão executa a sequência de interface separadamente.",
    "Classifique os campos de chamados usando EXCLUSIVAMENTE as regras fechadas abaixo.",
    "Não invente valores, campos, códigos nem combinações; não complete dados vazios.",
    "Normalize Intragov como verdadeiro apenas quando estiver marcado/Sim; essa informação também é usada pela automação local para aplicar o preenchimento de telefones. Intragov/Serviço ausentes não impedem combinações que já determinam o código.",
    "Prioridade: cliente SEDUC ou FED => 2A011, independente dos demais campos e sem perguntar ao usuário. Considere SEDUC quando o cliente contém SECRETARIA e EDUCAÇÃO/EDUCACAO, inclusive nomes como SAO PAULO SECRETARIA DA EDUCACAO, ou a sigla SEDUC. Considere FED quando o cliente contém FUNDO ou FUNDAÇÃO/FUNDACAO, DESENVOLVIMENTO e EDUCAÇÃO/EDUCACAO, ou a sigla FED. Para os demais clientes: 1) Tipo de Incidência DDR => 57033, independente dos demais campos; 2) Intragov true => 6Y200, independente do serviço e dos demais campos; 3) REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + PROATIVO => 2A082; 4) INICIAL + PREVENTIVO/REATIVO/PROATIVO ou REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + REATIVO => 2A011. Durante a baixa automática, a extensão pergunta ao usuário somente quando nenhuma regra nem escolha já aprendida identificar o código; escolhas anteriores iguais são reutilizadas.",
    "Diagnóstico: use 00000032 Testado OK quando Tipo de Incidência for DDR; nos demais casos use 00000017 Testado OK. A regra do diagnóstico depende somente da incidência e vale mesmo quando o código de baixa for definido pela prioridade do cliente.",
    "Retorne somente um objeto json válido conforme o schema. A palavra json neste pedido indica o formato obrigatório da resposta. Use exatamente as chaves e os tipos definidos; não inclua markdown, cercas de código nem texto antes ou depois do objeto. Confiança deve ser entre 0 e 1. Repita campos ausentes sem inventar valores."
  ].join(" ");

  function abortableSignal(signal, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const stop = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", stop, { once: true });
    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", stop);
      }
    };
  }

  function parseJsonObject(text, label) {
    if (!text) throw new Error(`${label} não retornou JSON.`);
    try { return JSON.parse(text); }
    catch { throw new Error(`${label} retornou JSON inválido.`); }
  }

  // O schema interno usa tipos em maiúsculas (OBJECT/STRING); o campo
  // responseFormat.text.schema da API atual espera JSON Schema em minúsculas.
  function toJsonSchema(node) {
    if (Array.isArray(node)) return node.map(toJsonSchema);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [
      key,
      key === "type" && typeof value === "string" ? value.toLowerCase() : toJsonSchema(value)
    ]));
  }

  function networkError(error, host) {
    if (error?.name === "AbortError") return error;
    return new Error(`Sem conexão com ${host}. Verifique a internet e se a rede/proxy/firewall da empresa libera esse endereço. (${error?.message || "falha de rede"})`);
  }

  function httpError(label, status, message, model) {
    const raw = String(message || "").replace(/\s+/g, " ").slice(0, 220);
    let hint = "";
    if (status === 401 || status === 403 || /api key not valid|api_key_invalid|invalid api key/i.test(raw)) hint = "Chave recusada: confira se a API Key está correta e ativa.";
    else if (status === 404) hint = `Modelo '${model}' não encontrado: troque o modelo nas configurações.`;
    else if (status === 429) hint = "Limite de uso do provedor atingido (por minuto ou por dia). Aguarde ou troque de provedor/modelo.";
    else if (status >= 500) hint = "O provedor está instável no momento; tente novamente.";
    return new Error(`${label} (HTTP ${status}): ${hint ? `${hint} ` : ""}${raw}`.trim());
  }

  async function postGemini(url, apiKey, body, signal) {
    const requestControl = abortableSignal(signal);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: requestControl.signal
      });
    } catch (error) {
      requestControl.cleanup();
      throw networkError(error, "generativelanguage.googleapis.com");
    }
    // O tempo limite também cobre a leitura do corpo da resposta.
    const data = await response.json().catch(() => ({})).finally(requestControl.cleanup);
    return { response, data };
  }

  async function requestGemini({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Gemini não configurada.");
    const selectedModel = String(model || root.BaixaHelpers.DEFAULT_MODELS.gemini).trim();
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(selectedModel)) throw new Error("Modelo Gemini inválido.");
    const url = `${GEMINI_BASE}${encodeURIComponent(selectedModel)}:generateContent`;
    const schema = toJsonSchema(root.BaixaAISchema.outputSchema);
    const base = {
      systemInstruction: { parts: [{ text: CLASSIFICATION_INSTRUCTIONS }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }]
    };
    // Modelos com raciocínio gastam parte do limite de saída "pensando"; 500 tokens
    // podiam esgotar antes do JSON. Por isso o limite é folgado.
    const attempts = [
      { ...base, generationConfig: { temperature: Number(temperature), maxOutputTokens: 2048, responseFormat: { text: { mimeType: "application/json", schema } } } },
      { ...base, generationConfig: { temperature: Number(temperature), maxOutputTokens: 2048, responseMimeType: "application/json", responseJsonSchema: schema } }
    ];
    let result;
    for (let index = 0; index < attempts.length; index++) {
      result = await postGemini(url, apiKey, attempts[index], signal);
      if (result.response.ok) break;
      const message = result.data.error?.message || "";
      // Se a API recusar o formato do pedido (campo desconhecido), tenta o formato clássico.
      const formatRejected = result.response.status === 400 && /unknown name|invalid json payload|cannot find field|unrecognized|responseFormat|responseJsonSchema|response_format/i.test(message);
      if (!formatRejected) break;
    }
    const { response, data: body } = result;
    if (!response.ok) throw httpError("Gemini API", response.status, body.error?.message, selectedModel);
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || "").join("").trim();
    if (!text) {
      const reason = candidate?.finishReason || body.promptFeedback?.blockReason || "sem motivo informado";
      throw new Error(`Gemini não retornou conteúdo estruturado (motivo: ${reason}).`);
    }
    return parseJsonObject(text, "Gemini");
  }

  async function requestGroq({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Groq não configurada.");
    const selectedModel = String(model || root.BaixaHelpers.DEFAULT_MODELS.groq).trim();
    if (!/^[a-zA-Z0-9._/-]{3,100}$/.test(selectedModel)) throw new Error("Modelo Groq inválido.");
    const requestControl = abortableSignal(signal);
    let response;
    try {
      response = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: selectedModel,
          temperature: Number(temperature),
          max_completion_tokens: 2000,
          ...(/gpt-oss/i.test(selectedModel) ? { reasoning_effort: "low" } : {}),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${CLASSIFICATION_INSTRUCTIONS} O objeto deve conter codigoBaixa, diagnostico, motivo, confianca (0 a 1), podeExecutar e normalizedFields com os seis campos originais normalizados. Não inclua texto fora do JSON.` },
            { role: "user", content: `Classifique estes campos e responda somente com json válido: ${JSON.stringify(payload)}` }
          ]
        }),
        signal: requestControl.signal
      });
    } catch (error) {
      requestControl.cleanup();
      throw networkError(error, "api.groq.com");
    }
    const body = await response.json().catch(() => ({})).finally(requestControl.cleanup);
    if (!response.ok) {
      if (body.error?.code === "json_validate_failed" || /failed to generate json/i.test(body.error?.message || "")) {
        throw new Error("Groq não conseguiu gerar uma resposta JSON válida neste modelo. Nenhuma decisão da IA foi aceita; tente novamente ou use o motor determinístico.");
      }
      throw httpError("Groq API", response.status, body.error?.message, selectedModel);
    }
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`Groq retornou resposta vazia (finish_reason: ${body.choices?.[0]?.finish_reason || "desconhecido"}).`);
    return parseJsonObject(text, "Groq");
  }

  const adapters = new Map([["gemini", requestGemini], ["groq", requestGroq]]);
  const api = {
    request(providerOptions) {
      const adapter = adapters.get(providerOptions.provider);
      if (!adapter) throw new Error("Provedor não instalado neste adaptador.");
      return adapter(providerOptions);
    },
    providers: [...adapters.keys()],
    toJsonSchema,
    defaults: root.BaixaHelpers.DEFAULT_MODELS,
    registerProvider(name, adapter) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(name) || typeof adapter !== "function") throw new Error("Adaptador inválido.");
      adapters.set(name, adapter);
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAIProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: ai/ai-service.js */
(function (root) {
  "use strict";

  async function analyzeCase(input, settings, signal) {
    const payload = root.BaixaHelpers.buildAIPayload(input);
    const required = ["tipoAbertura", "procedencia", "tipoIncidencia"];
    const missing = required.filter(key => !String(payload[key] || "").trim());
    if (missing.length) return { available: false, reason: `Campos ausentes; IA não consultada: ${missing.join(", ")}.`, payload };
    if (payload.intragov === null || !payload.servicoAfetado) {
      return { available: false, reason: "Intragov ou Serviço Afetado não identificado; usando as regras determinísticas locais.", payload };
    }
    if (!settings?.apiKey) return { available: false, reason: "IA não configurada; usando somente as regras determinísticas.", payload };

    try {
      const raw = await root.BaixaAIProvider.request({
        provider: settings.provider || "gemini",
        apiKey: settings.apiKey,
        model: settings.model || root.BaixaHelpers.DEFAULT_MODELS.gemini,
        temperature: Number(settings.temperature ?? 0),
        payload,
        signal
      });
      const decision = root.BaixaAISchema.validateDecision(raw);
      return { available: true, provider: settings.provider || "Gemini API", decision, payload };
    } catch (error) {
      return {
        available: false,
        reason: `IA indisponível: ${error.message} A decisão será avaliada pelo motor determinístico local.`,
        payload
      };
    }
  }

  const api = { analyzeCase };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAIService = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: background/run-guard.js */
(function (root) {
  "use strict";

  function authorizeRun({ tabId, runId, persistentRun, memoryRun, stopRequested = false, hasOtherActiveRun = false }) {
    if (!runId) return { allowed: false, reason: "ID da execução ausente." };

    const memoryMatches = memoryRun?.runId === runId;
    const storageMatches = persistentRun?.tabId === tabId && persistentRun?.runId === runId;

    if (memoryMatches && memoryRun.controller?.signal?.aborted) {
      return { allowed: false, reason: "A automação foi interrompida." };
    }
    if (storageMatches && persistentRun.stopped) {
      return { allowed: false, reason: "A automação foi interrompida." };
    }
    if (storageMatches) return { allowed: true, repairStorage: false, source: "storage" };

    // O background é quem criou este runId. Se o mesmo run ainda está vivo em
    // memória, seu registro local tem precedência sobre uma chave de storage
    // antiga que possa ter sido limpa por uma execução anterior.
    if (memoryMatches && !memoryRun.controller?.signal?.aborted) {
      if (stopRequested) return { allowed: false, reason: "A automação foi interrompida." };
      if (persistentRun && persistentRun.tabId !== tabId && !persistentRun.stopped) {
        return { allowed: false, reason: "Há outra execução ativa em uma guia diferente." };
      }
      return { allowed: true, repairStorage: true, source: "memory" };
    }

    if (persistentRun?.tabId === tabId && persistentRun.runId !== runId && !persistentRun.stopped) {
      return { allowed: false, reason: "Esta solicitação foi substituída por uma execução mais recente." };
    }
    if (persistentRun && persistentRun.tabId !== tabId && !persistentRun.stopped) {
      return { allowed: false, reason: "Há outra execução ativa em uma guia diferente." };
    }

    // Repare somente quando não existe lock concorrente nem parada explícita.
    // Isso cobre a suspensão do service worker sem reviver execuções canceladas.
    if (!persistentRun && !memoryRun && !stopRequested && !hasOtherActiveRun) {
      return { allowed: true, repairStorage: true, source: "recovered-request" };
    }

    return { allowed: false, reason: "A execução não está ativa ou foi interrompida." };
  }

  const api = { authorizeRun };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaRunGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

/* bundled: background/background.js */
"use strict";

const SIGITM_HOST = "sigitm.redecorp.br";
const BATCH_STORAGE_KEY = "baixaBatchRun";
const MASSIVE_LIST_URL = "http://sigitm.redecorp.br/SIGITMWeb/pages/consulta/listConsulta.jsf?idConsulta=95803";
// O protocolo é versionado para impedir que um content script antigo, que
// ficou aberto após atualizar a extensão, execute uma automação desatualizada.
const CONTENT_PROTOCOL = "baixa-controller-v8";
const CONTENT_MESSAGES = Object.freeze({
  status: "GET_BAIXADOR_CONTENT_STATUS",
  start: "START_ANALYSIS_V8",
  readBatch: "READ_BATCH_LIST_STATE_V8",
  clickBatch: "CLICK_BATCH_TICKET_V8",
  refreshBatch: "REFRESH_BATCH_LIST_V8",
  batchStatus: "BATCH_STATUS_V8"
});
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

// Content scripts também têm sender.id igual ao da extensão; só páginas da
// própria extensão (popup/opções, URL chrome-extension://) são autorizadas.
function senderIsExtension(sender) {
  return sender.id === chrome.runtime.id && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
}
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

async function hasCurrentContent(tabId) {
  try {
    const response = await sendTabMessage(tabId, { type: CONTENT_MESSAGES.status });
    return response?.ok === true && response.protocol === CONTENT_PROTOCOL;
  } catch {
    return false;
  }
}

async function ensureCurrentContent(tabId) {
  if (await hasCurrentContent(tabId)) return;
  // Recupera páginas carregadas antes da extensão e substitui controladores de
  // versões anteriores. As mensagens V8 não são aceitas pelos controladores antigos.
  await injectContent(tabId);
  if (!await hasCurrentContent(tabId)) {
    throw new Error("O content script atualizado não respondeu após a reinjeção. Atualize a página SIGITM e tente novamente.");
  }
}

async function startContent(tabId, runId, batch = null) {
  await ensureCurrentContent(tabId);
  const response = await sendTabMessage(tabId, { type: CONTENT_MESSAGES.start, runId, batch, protocol: CONTENT_PROTOCOL });
  if (!response?.ok) throw new Error(response?.error || "O content script não confirmou o início do ticket.");
}

async function sendBatchListMessage(tabId, message) {
  await ensureCurrentContent(tabId);
  let response;
  try { response = await sendTabMessage(tabId, message); }
  catch (error) { throw new Error(`Content script indisponível na tabela: ${error.message}`); }
  if (!response?.ok) throw new Error(response?.error || "A lista SIGITM não respondeu. Atualize a guia e tente novamente.");
  return response;
}

function setLiveStatus(message, status = "info", extra = {}) {
  return BaixaStorage.set({
    baixaLiveStatus: {
      message: String(message || ""),
      status: status === "error" ? "error" : status === "success" ? "success" : "info",
      updatedAt: new Date().toISOString(),
      ...extra
    }
  }).catch(() => undefined);
}

function sendBatchStatus(batch, message, status = "info") {
  if (!batch || typeof batch.listTabId !== "number") return;
  void setLiveStatus(message, status, {
    phase: status === "error" ? "atenção" : status === "success" ? "concluído" : "processando lista",
    listName: batch.listName,
    sequence: batch.sequence || "",
    processed: batch.processed?.size || 0
  });
  chrome.tabs.sendMessage(batch.listTabId, { type: CONTENT_MESSAGES.batchStatus, message, status, protocol: CONTENT_PROTOCOL }, () => void chrome.runtime.lastError);
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

// Nomes que nunca devem ser chamados como "função de fechamento" do popup.
const BLOCKED_PAGE_FUNCTIONS = /^(?:eval|alert|confirm|prompt|open|print|close|logout|setTimeout|setInterval|fetch|Function)$/i;

// Fecha um popup RichFaces/legado no mundo MAIN da página. A CSP da página
// bloqueia javascript: e scripts inline, mas chrome.scripting com `func` é
// permitido. Só aceita ids/nomes simples vindos do controle X já identificado.
async function closePopupInPage(tabId, request) {
  const kind = request?.kind === "richfaces" ? "richfaces" : request?.kind === "function" ? "function" : "";
  const value = String(request?.value || "");
  const valid = kind === "richfaces" ? /^[\w$.:\-]{1,200}$/.test(value)
    : kind === "function" && /^[A-Za-z_$][\w$]{0,80}$/.test(value) && !BLOCKED_PAGE_FUNCTIONS.test(value);
  if (!valid) throw new Error("Pedido de fechamento de popup inválido.");
  const executions = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [kind, value],
    func: (requestKind, requestValue) => {
      const windows = [];
      const collect = current => {
        windows.push(current);
        for (let index = 0; index < current.frames.length; index++) {
          try { collect(current.frames[index]); } catch { /* frame de outra origem */ }
        }
      };
      collect(window);
      for (const view of windows) {
        try {
          if (requestKind === "richfaces") {
            const richFaces = view.RichFaces || view.Richfaces;
            if (typeof richFaces?.hideModalPanel === "function") { richFaces.hideModalPanel(requestValue); return true; }
          } else if (typeof view[requestValue] === "function") {
            view[requestValue]();
            return true;
          }
        } catch { /* tenta o próximo frame */ }
      }
      return false;
    }
  });
  return executions?.some(item => item.result === true) === true;
}

function activateTab(tabId) {
  return new Promise((resolve, reject) => chrome.tabs.update(tabId, { active: true }, tab => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(tab);
  }));
}

async function returnToListAndRefresh(batch) {
  await activateTab(batch.listTabId);
  const refreshed = await sendBatchListMessage(batch.listTabId, { type: CONTENT_MESSAGES.refreshBatch, protocol: CONTENT_PROTOCOL });
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
  const refreshed = await sendBatchListMessage(listTab.id, { type: CONTENT_MESSAGES.refreshBatch, protocol: CONTENT_PROTOCOL });
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
  await setLiveStatus(message, status === "error" ? "error" : "success", {
    phase: status === "error" ? "atenção" : "concluído",
    listName: batch.listName,
    sequence: batch.sequence || "",
    processed: batch.processed?.size || 0
  });
  sendBatchStatus(batch, message, status);
  // Não feche guias de ticket em caminhos genéricos de erro/parada. O único
  // fechamento automático ocorre no handler BATCH_TICKET_FINISHED, após a
  // confirmação de sucesso ter sido lida na página.
}

async function processNextBatchTicket(batch) {
  if (!batch || batch.finished || batch.processing || batch.ticketTabId) return;
  batch.processing = true;
  try {
    const response = await sendBatchListMessage(batch.listTabId, { type: CONTENT_MESSAGES.readBatch, protocol: CONTENT_PROTOCOL });
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
        await sendBatchListMessage(batch.listTabId, { type: CONTENT_MESSAGES.refreshBatch, protocol: CONTENT_PROTOCOL });
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
      reason: `Cliente SEDUC/FED: código ${automaticClientCode} aplicado sem perguntar e sem depender da resposta da IA.`
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

  if (["LIST_LEARNING", "DELETE_LEARNING", "CLEAR_LEARNING", "IMPORT_LEARNING"].includes(message?.type)) {
    if (!senderIsExtension(sender)) { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    const work = message.type === "LIST_LEARNING" ? BaixaStorage.listLearnedCodes().then(entries => ({ entries }))
      : message.type === "DELETE_LEARNING" ? BaixaStorage.deleteLearnedCode(String(message.key || "")).then(deleted => ({ deleted }))
        : message.type === "CLEAR_LEARNING" ? BaixaStorage.clearLearnedCodes().then(() => ({}))
          : BaixaStorage.importLearnedCodes(message.entries).then(summary => ({ ...summary }));
    work.then(result => sendResponse({ ok: true, ...result })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "PAGE_CLOSE_POPUP") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    closePopupInPage(sender.tab.id, message)
      .then(closed => sendResponse({ ok: true, closed }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
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

  if (message?.type === "AUTOMATION_STATUS") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false, error: "Origem não autorizada." }); return false; }
    setLiveStatus(message.message, message.status, {
      phase: message.status === "error" ? "atenção" : "processando",
      tabId: sender.tab.id,
      runId: String(message.runId || "")
    }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "RUN_FINISHED") {
    if (!senderIsSigitm(sender) || typeof sender.tab?.id !== "number") { sendResponse({ ok: false }); return false; }
    BaixaStorage.get("baixaActiveRun").then(async stored => {
      const run = stored.baixaActiveRun;
      const matchesRun = run?.tabId === sender.tab.id && run?.runId === message.runId;
      if (matchesRun) await BaixaStorage.set({ baixaActiveRun: null });
      if (activeRuns.get(sender.tab.id)?.runId === message.runId) activeRuns.delete(sender.tab.id);
      await setLiveStatus("Execução encerrada. O resultado final foi salvo no histórico.", "success", { phase: "concluído", tabId: sender.tab.id, runId: message.runId });
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
    Promise.all([BaixaStorage.get([BaixaStorage.KEYS.current, BaixaStorage.KEYS.history, BaixaStorage.KEYS.stop, "baixaAiConnectionStatus", "baixaActiveRun", "baixaLiveStatus", BATCH_STORAGE_KEY]), BaixaStorage.getSettings()])
      .then(([stored, settings]) => {
        const activeRun = stored.baixaActiveRun;
        const activeBatch = stored[BATCH_STORAGE_KEY];
        const liveStatus = stored.baixaLiveStatus || null;
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
        aiConnection: stored.baixaAiConnectionStatus || null,
        liveStatus,
        activeBatch: activeBatch ? {
          batchId: activeBatch.batchId,
          listName: activeBatch.listName,
          sequence: activeBatch.sequence || "",
          processed: Array.isArray(activeBatch.processed) ? activeBatch.processed.length : 0,
          ticketOpen: typeof activeBatch.ticketTabId === "number" && activeBatch.ticketTabId > 0,
          finished: Boolean(activeBatch.finished)
        } : null
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
        model: String(message.settings?.model || current.model || BaixaHelpers.DEFAULT_MODELS[provider]).trim(),
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
      model: String(value.model || BaixaHelpers.DEFAULT_MODELS[provider]).trim(),
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
