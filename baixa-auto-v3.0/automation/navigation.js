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
