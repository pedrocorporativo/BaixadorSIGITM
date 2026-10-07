(function (root) {
  "use strict";

  function findUniqueButton(labels) {
    const wanted = new Set(labels.map(root.BaixaNavigation.normalize));
    const selector = "button, input, a, [role='button'], [onclick], [tabindex]";
    const candidates = root.BaixaNavigation.documents().flatMap(doc => [...doc.querySelectorAll(selector)])
      .filter(element => root.BaixaNavigation.visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true" && !isCloseControl(element));
    const exact = candidates.filter(element => wanted.has(buttonLabel(element)));
    const selected = exact.length ? exact : candidates.filter(element => {
      const label = buttonLabel(element);
      return [...wanted].some(term => term.length >= 4 && (label.startsWith(term) || label.endsWith(term)));
    });
    const unique = [...new Set(selected)].filter(candidate => !selected.some(other =>
      other !== candidate && candidate.contains?.(other) && wanted.has(buttonLabel(other))));
    if (unique.length !== 1) {
      const action = labels.join(" / ");
      throw new Error(`Botão “${action}” ${unique.length ? `ambíguo (${unique.length} correspondências)` : "não encontrado"}; ação bloqueada.`);
    }
    return unique[0];
  }

  async function waitForUniqueButton(labels, timeout = 10000, shouldStop = () => false) {
    await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);
    const button = await waitFor(() => {
      try { return findUniqueButton(labels); }
      catch (error) {
        if (/não encontrado/.test(error.message)) return false;
        throw error;
      }
    }, timeout, shouldStop);
    if (!button) throw new Error(`Botão “${labels.join(" / ")}" não apareceu após o carregamento da tela; ação bloqueada.`);
    return button;
  }

  function feedbackText() {
    const selectors = "[role='alert'], [role='status'], [role='dialog'], [aria-modal='true'], .alert, .ui-messages, .ui-message, .toast, .notification, .modal, .swal2-popup";
    return root.BaixaNavigation.documents().flatMap(doc => [...doc.querySelectorAll(selectors)])
      .filter(root.BaixaNavigation.visible).map(root.BaixaNavigation.textOf).join(" ");
  }

  function isCloseControl(element) {
    const label = root.BaixaNavigation.normalize([
      element.getAttribute("aria-label"), element.getAttribute("title"), element.value,
      root.BaixaNavigation.textOf(element)
    ].filter(Boolean).join(" "));
    const classes = root.BaixaNavigation.normalize(String(element.className || ""));
    return /(^| )(fechar|close|dismiss|x)( |$)/.test(label) || /(^| )(close|dismiss|fechar)( |$)/.test(classes);
  }

  function buttonLabel(element) {
    return root.BaixaNavigation.normalize([
      root.BaixaNavigation.textOf(element), element.value, element.getAttribute("aria-label"),
      element.getAttribute("title"), element.getAttribute("alt"), element.querySelector("img")?.alt,
      element.querySelector("img")?.title, element.querySelector("img")?.getAttribute("src"),
      element.id, element.name
    ].filter(Boolean).join(" "));
  }

  function visiblePopups() {
    const selector = "[role='dialog'], [aria-modal='true'], .modal, .swal2-popup, .ui-dialog, .ui-dialog-content";
    const semantic = root.BaixaNavigation.documents().flatMap(doc => [...doc.querySelectorAll(selector)])
      .filter(root.BaixaNavigation.visible);
    const messageWindows = root.BaixaNavigation.documents().flatMap(doc => {
      const candidates = [...doc.querySelectorAll("div, table, section, fieldset, form")].filter(node => {
        if (!root.BaixaNavigation.visible(node)) return false;
        const text = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(node));
        const rect = node.getBoundingClientRect();
        if (/tiquete bloqueado/.test(text) && rect.width >= 300 && rect.height >= 150) return true;
        const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
        const isOverlay = ["fixed", "absolute"].includes(style?.position) || Number(style?.zIndex) >= 100;
        // Algumas mensagens do SIGITM após Baixar não têm role="dialog". Para
        // evitar tocar no restante da página, só tratamos um contêiner flutuante
        // que tenha exatamente um X reconhecido no canto superior direito.
        return isOverlay && rect.width >= 180 && rect.height >= 70 && closeImageCandidates(node).length === 1;
      });
      return candidates.sort((a, b) => {
        const aHasClose = closeImageCandidates(a).length > 0;
        const bHasClose = closeImageCandidates(b).length > 0;
        if (aHasClose !== bHasClose) return aHasClose ? -1 : 1;
        const first = a.getBoundingClientRect();
        const second = b.getBoundingClientRect();
        return first.width * first.height - second.width * second.height;
      }).slice(0, 1);
    });
    return [...new Set([...semantic, ...messageWindows])];
  }

  function closeImageCandidates(popup) {
    const rootRect = popup.getBoundingClientRect?.();
    const selector = "button, input[type='image'], a, [onclick], [role='button'], [tabindex], img, svg, i";
    const candidates = [...popup.querySelectorAll(selector)].filter(element => {
      if (!root.BaixaNavigation.visible(element) || element.disabled) return false;
      const image = element.matches("img, svg, i") ? element : element.querySelector?.("img, svg, i");
      const metadata = root.BaixaNavigation.normalize([
        element.id, element.name, element.title, element.alt, element.value,
        element.getAttribute("aria-label"), element.getAttribute("src"),
        element.getAttribute("onclick"), element.onclick?.toString(), image?.id, image?.className, image?.title, image?.alt,
        image?.getAttribute("src"), image?.src, image?.getAttribute("onclick"),
        root.BaixaNavigation.textOf(element)
      ].filter(Boolean).join(" "));
      if (/(fechar|fecha|close|dismiss|botao x|close\.gif|fechar\.gif|btnclose|closebutton)/.test(metadata) || /(^| )(x|×)( |$)/.test(metadata)) return true;
      if (!rootRect) return false;
      const rect = (image || element).getBoundingClientRect();
      const smallIcon = rect.width > 0 && rect.width <= 48 && rect.height > 0 && rect.height <= 48;
      const topRight = rect.right >= rootRect.right - 55 && rect.top <= rootRect.top + 55;
      return smallIcon && topRight;
    });
    return [...new Set(candidates.map(element =>
      element.matches("img, svg, i") ? element.closest("a, button, [onclick], [role='button'], [tabindex]") || element : element
    ))];
  }

  function invokeSafeJavaScriptClose(control) {
    const href = String(control.getAttribute("href") || "").trim();
    if (!/^javascript:/i.test(href)) return false;
    const expression = href.replace(/^javascript:/i, "").trim();
    const match = expression.match(/^(?:(?:window|self)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?$/i);
    if (!match) return false;
    const view = control.ownerDocument?.defaultView;
    if (!view) return false;
    const functionName = match[1];
    if (functionName.toLowerCase() === "close") {
      if (!view.opener) return false;
      view.close();
      return true;
    }
    const handler = view[functionName];
    if (typeof handler !== "function") return false;
    handler.call(view);
    return true;
  }

  async function clickPopupClose(control, popup, shouldStop = () => false) {
    const href = String(control.getAttribute("href") || "").trim();
    if (!/^javascript:/i.test(href)) {
      control.click();
      return;
    }

    // Preserve regular page listeners while cancelling the CSP-blocked javascript: navigation.
    control.addEventListener("click", event => event.preventDefault(), { capture: true, once: true });
    control.click();
    if (await waitFor(() => !visiblePopups().includes(popup), 900, shouldStop)) return;
    if (invokeSafeJavaScriptClose(control)) return;
    throw new Error("O X usa uma URL javascript: bloqueada pela CSP e não expõe um fechamento seguro; popup mantido aberto.");
  }

  async function closeBlockPopup(shouldStop = () => false, action = "Bloquear") {
    const popup = await waitFor(() => visiblePopups()[0] || null, 2500, shouldStop);
    if (!popup) return false;
    const message = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(popup));
    if (/erro.{0,60}(log|baixa)|falha.{0,60}(log|baixa)|log.{0,60}(erro|falha)/.test(message)) {
      throw new Error(`Popup de erro após ${action}; fluxo cancelado: ${root.BaixaNavigation.textOf(popup)}`);
    }
    const closeCandidates = [...popup.querySelectorAll("button, input[type='button'], input[type='submit'], input[type='image'], a, [role='button'], [onclick], [tabindex], img, svg, i")]
      .filter(element => root.BaixaNavigation.visible(element) && !element.disabled && isCloseControl(element))
      .map(element => element.matches("img, svg, i")
        ? element.closest("a, button, [onclick], [role='button'], [tabindex]") || element
        : element);
    const unique = [...new Set([...closeCandidates, ...closeImageCandidates(popup)])];
    if (unique.length !== 1) throw new Error(`Popup após ${action}: controle Fechar ${unique.length ? "ambíguo" : "não encontrado"}; fluxo pausado.`);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    await clickPopupClose(unique[0], popup, shouldStop);
    const closed = await waitFor(() => !visiblePopups().includes(popup), 5000, shouldStop);
    if (!closed) throw new Error(`O popup após ${action} continuou aberto; próximo passo cancelado.`);
    return true;
  }

  async function beginMainClosure(shouldStop = () => false) {
    await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);
    const blockButton = findUniqueButton(["Bloquear"]);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    blockButton.click();
    await closeBlockPopup(shouldStop);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    if (!await root.BaixaNavigation.clickTab("Cliente", shouldStop)) throw new Error("Aba Cliente indisponível após fechar a mensagem de bloqueio.");
    const downloadButton = await waitForUniqueButton(["Baixar"], 10000, shouldStop);
    downloadButton.click();
    // O SIGITM pode exibir uma mensagem sobre a baixa inicial. Ela deve ser
    // fechada pelo X antes de navegar para o Encerramento.
    await closeBlockPopup(shouldStop, "Baixar");
    await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);
    return true;
  }

  async function saveMainClosure(shouldStop = () => false) {
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);
    const button = findUniqueButton(["Gravar Baixa"]);
    button.click();

    // Quando o SIGITM rejeita a gravação, ele mostra "Validation Error:
    // Value is required." em um ou mais campos. O chamador usa esse retorno
    // para corrigir a aba Certificação e tentar Gravar Baixa novamente.
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      const text = root.BaixaNavigation.documents().map(doc => root.BaixaNavigation.textOf(doc.body)).join("\n");
      if (/Validation Error:\s*Value is required/i.test(text)) return { saved: false, validationError: true };
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return { saved: true, validationError: false };
  }

  async function waitForTicketReleased(timeout = 30000, shouldStop = () => false) {
    const hasTicketReleased = doc => {
      const released = text => /(?:ticket|tiquete)[\s\S]{0,100}liberado/.test(root.BaixaNavigation.normalize(text));
      // O modal da tela final pode ser montado sem role/classe semântica. Ler
      // o body garante a identificação do texto “Tíquete Liberado.” da janela.
      if (released(root.BaixaNavigation.textOf(doc.body))) return true;
      const selectors = "[role='dialog'], [role='alert'], [role='status'], [aria-modal='true'], .modal, .ui-dialog, table, div, td, span, p";
      return [...doc.querySelectorAll(selectors)].some(element => root.BaixaNavigation.visible(element) && released(root.BaixaNavigation.textOf(element)));
    };
    const released = await waitFor(() => root.BaixaNavigation.documents().some(hasTicketReleased), timeout, shouldStop, 100);
    if (!released) return false;
    // O aviso do SIGITM é a confirmação do servidor; aguarde um curto período
    // de estabilidade para não fechar a guia durante a renderização do modal.
    await new Promise(resolve => setTimeout(resolve, 400));
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    return root.BaixaNavigation.documents().some(hasTicketReleased);
  }

  async function waitFor(predicate, timeout = 12000, shouldStop = () => false, pollMs = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      const value = predicate();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return false;
  }

  async function closeActiveAction(data, shouldStop = () => false) {
    if (data.codigoAcionamento !== "6Z036" || data.acionamento !== "Sim") return false;
    if (!await root.BaixaNavigation.clickTab("Acionamento", shouldStop)) throw new Error("Aba Acionamento indisponível.");
    const code = root.BaixaNavigation.readField(["Código do Acionamento", "Código Completo do Acionamento"]);
    if (code && root.BaixaNavigation.normalize(code) !== "6z036") throw new Error("Acionamento ativo não corresponde a 6Z036.");
    root.BaixaFormHandler.fill(["Responsável"], "xx");
    root.BaixaFormHandler.fill(["Descrição"], "xx");
    root.BaixaFormHandler.verify(["Responsável"], "xx");
    root.BaixaFormHandler.verify(["Descrição"], "xx");
    const button = findUniqueButton(["Baixar Acionamento", "Confirmar Baixa do Acionamento", "Baixar"]);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    button.click();
    const confirmed = await waitFor(() => /acionamento.{0,50}(baixado|encerrado|sucesso)|baixa.{0,50}acionamento.{0,50}sucesso/i.test(root.BaixaNavigation.normalize(feedbackText())), 12000, shouldStop);
    if (!confirmed) throw new Error("SIGITM não confirmou a baixa do acionamento 6Z036.");
    return true;
  }

  async function confirmMainClosure(shouldStop = () => false) {
    if (!await root.BaixaNavigation.clickTab("Encerramento", shouldStop)) throw new Error("Aba Encerramento indisponível.");
    const button = findUniqueButton(["Confirmar Baixa", "Confirmar", "Baixar", "Salvar", "Encerrar", "Concluir"]);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    button.click();
    const result = await waitFor(() => {
      const feedback = feedbackText();
      const message = root.BaixaNavigation.normalize(feedback);
      if (/erro.{0,50}(baixa|encerramento|log)|falha.{0,50}(baixa|encerramento|log)|nao foi possivel.{0,50}(baix|encerr)|log.{0,50}(erro|falha)/.test(message)) {
        return `ERRO NO SISTEMA — ${feedback || "o SIGITM recusou a baixa."}`;
      }
      if (/baixa realizada com sucesso|chamado baixado com sucesso|encerrado com sucesso/.test(message)) return "BAIXA REALIZADA";
      const status = root.BaixaNavigation.normalize(root.BaixaNavigation.readField(["Status", "Situação", "Situacao"]));
      if (["baixado", "baixada", "encerrado", "encerrada", "fechado", "fechada"].includes(status)) return "BAIXA REALIZADA";
      return "";
    }, 12000, shouldStop);
    return result || "ERRO NO SISTEMA — o SIGITM não confirmou a baixa; o pop-up foi mantido aberto.";
  }

  const api = { findUniqueButton, waitForUniqueButton, isCloseControl, closeImageCandidates, invokeSafeJavaScriptClose, clickPopupClose, closeBlockPopup, beginMainClosure, saveMainClosure, waitForTicketReleased, closeActiveAction, confirmMainClosure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaHandler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
