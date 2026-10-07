(function (root) {
  "use strict";
  // As telas legadas do SIGITM frequentemente atualizam o conteúdo depois do
  // clique visual na aba; três segundos evitam procurar campos cedo demais.

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
    return Boolean(element && (element.getClientRects?.().length || element.offsetParent));
  }

  function normalize(value) { return root.BaixaHelpers.normalizeText(value); }
  function textOf(element) { return String(element?.innerText || element?.textContent || "").trim(); }

  function loadingIndicators() {
    const selectors = "[aria-busy='true'], .loading, .loader, .spinner, .blockUI, .block-ui, .ui-blockui, .ajax-loader, [id*='loading' i], [class*='loading' i], [id*='spinner' i], [class*='spinner' i], img[src*='loading' i], img[src*='spinner' i], img[src*='ajax' i]";
    const found = new Set(documents().flatMap(doc => [...doc.querySelectorAll(selectors)])
      .filter(element => visible(element) && getComputedStyleSafe(element)?.display !== "none"));
    for (const doc of documents()) {
      const view = doc.defaultView;
      const width = view?.innerWidth || 0;
      const height = view?.innerHeight || 0;
      if (!width || !height) continue;
      for (const icon of doc.querySelectorAll("img, svg")) {
        if (!visible(icon)) continue;
        const rect = icon.getBoundingClientRect();
        const centered = rect.width <= 160 && rect.height <= 160 &&
          Math.abs(rect.left + rect.width / 2 - width / 2) < width * 0.22 &&
          Math.abs(rect.top + rect.height / 2 - height / 2) < height * 0.22;
        if (!centered) continue;
        for (let parent = icon.parentElement; parent; parent = parent.parentElement) {
          const parentRect = parent.getBoundingClientRect?.();
          const style = getComputedStyleSafe(parent);
          if (parentRect && parentRect.width > width * 0.55 && parentRect.height > height * 0.55 &&
            ["fixed", "absolute"].includes(style?.position) && Number(style?.zIndex || 0) >= 10) {
            found.add(icon);
            break;
          }
        }
      }
    }
    return [...found];
  }

  function getComputedStyleSafe(element) {
    try { return element.ownerDocument.defaultView.getComputedStyle(element); }
    catch { return null; }
  }

  async function waitForLoadingToFinish(shouldStop = () => false, timeout = 45000) {
    const end = Date.now() + timeout;
    while (loadingIndicators().length) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      if (Date.now() >= end) throw new Error("A tela de carregamento do SIGITM não terminou no tempo esperado.");
      await new Promise(resolve => setTimeout(resolve, 100));
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

  async function clickTab(name, shouldStop = () => false) {
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    const deadline = Date.now() + 15000;
    let unique = [];
    while (Date.now() < deadline) {
      await waitForLoadingToFinish(shouldStop);
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      unique = findTabCandidates(name);
      if (unique.length) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (unique.length !== 1) throw new Error(`Aba ${name} ${unique.length ? "ambígua" : "não encontrada após aguardar a interface carregar"}.`);
    unique[0].click();
    if (loadingIndicators().length) await waitForLoadingToFinish(shouldStop);
    return !shouldStop();
  }

  async function readCase(shouldStop = () => false, onTab = () => {}) {
    onTab("Cliente");
    if (!await clickTab("Cliente", shouldStop)) throw new Error("Automação interrompida.");
    const cliente = readField(["Cliente"]);
    let servicoAfetado = readField(["Serviço Afetado", "Servico Afetado"]);

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

  const api = { documents, visible, normalize, textOf, controlsFor, valueOf, readField, readIntragov, resolveActionState, loadingIndicators, waitForLoadingToFinish, clickTab, readCase };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaNavigation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
