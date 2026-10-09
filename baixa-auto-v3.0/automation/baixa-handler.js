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
    const raw = [
      element.getAttribute?.("aria-label"), element.getAttribute?.("title"), element.value,
      element.getAttribute?.("alt"), element.getAttribute?.("data-dismiss"),
      element.getAttribute?.("data-close"), element.getAttribute?.("name"), element.id,
      root.BaixaNavigation.textOf(element), String(element.className || "")
    ].filter(Boolean).join(" ");
    const normalized = root.BaixaNavigation.normalize(raw);
    const rawLower = raw.toLowerCase();
    const closeWord = /(^|[\s:_\-])(?:fechar|fecha|close|dismiss|cancelar)(?=$|[\s:_\-])/i;
    const closeSymbol = /(^|[\s"'=>(])(?:x|×|✕|✖|✗|✘)(?=$|[\s"'=<),.:-])/iu;
    const dataClose = String(element.getAttribute?.("data-dismiss") || element.getAttribute?.("data-close") || "").toLowerCase();
    const compact = rawLower.replace(/[^a-z0-9]+/g, "");
    return closeWord.test(rawLower) || closeSymbol.test(rawLower) || closeWord.test(normalized) ||
      /^(?:close|dismiss|fechar)$/i.test(dataClose) ||
      /(?:close|dismiss|fechar)(?:button|icon|btn|popup)/i.test(rawLower) ||
      /(?:btn|button)(?:close|fechar|dismiss)/i.test(compact);
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
    // O SIGITM legado usa RichFaces: a janela do print é um rich-mpnl-panel,
    // sem role=dialog, modal ou popup no nome. Incluímos suas variações para
    // conseguir fechar o X antes de trocar para a aba Certificação.
    const selector = "[role='dialog'], [aria-modal='true'], .modal, .swal2-popup, .ui-dialog, .ui-dialog-content, [class*='popup' i], [id*='popup' i], .rich-mpnl-panel, .rich-mpnl-content, [class*='rich-mpnl' i], [id*='rich-mpnl' i], [class*='modalpanel' i], [id*='modalpanel' i]";
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

  function popupControlMetadata(element) {
    return root.BaixaNavigation.normalize([
      element?.id, element?.name, element?.title, element?.alt, element?.value,
      element?.getAttribute?.("aria-label"), element?.getAttribute?.("data-dismiss"),
      element?.getAttribute?.("data-close"), element?.getAttribute?.("src"),
      element?.getAttribute?.("onclick"), element?.onclick?.toString?.(),
      root.BaixaNavigation.textOf(element)
    ].filter(Boolean).join(" "));
  }

  function closeImageCandidates(popup) {
    const rootRect = popup.getBoundingClientRect?.();
    if (!rootRect) return [];
    const selector = "button, input[type='image'], input[type='button'], a, [onclick], [role='button'], [tabindex], img, svg, i";
    const scored = [];
    for (const element of popup.querySelectorAll(selector)) {
      if (!root.BaixaNavigation.visible(element) || element.disabled) continue;
      const visual = element.matches("img, svg, i") ? element : element.querySelector?.("img, svg, i");
      const target = visual?.closest?.("a, button, input[type='image'], [onclick], [role='button'], [tabindex]") || element;
      const rect = (visual || target).getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const raw = [popupControlMetadata(element), popupControlMetadata(visual), popupControlMetadata(target)].filter(Boolean).join(" ");
      const small = rect.width <= 52 && rect.height <= 52;
      const topRight = rect.right >= rootRect.right - 65 && rect.top <= rootRect.top + 70;
      const symbol = /(?:^|[\s:._-])(?:x|×|✕|✖|✗|✘)(?:$|[\s:._-])/iu.test(raw);
      const named = /(?:fechar|fecha|close|dismiss|botao x|btnclose|closebutton|fechar\.gif|close\.gif)/i.test(raw);
      if ((small && topRight) || symbol || named) {
        const score = (topRight ? 100 : 0) + (small ? 40 : 0) + (named ? 35 : 0) + (symbol ? 30 : 0);
        scored.push({ target, score, rect });
      }
    }
    const grouped = new Map();
    for (const item of scored) {
      const previous = grouped.get(item.target);
      if (!previous || item.score > previous.score) grouped.set(item.target, item);
    }
    return [...grouped.values()]
      .sort((a, b) => b.score - a.score || a.rect.top - b.rect.top || b.rect.right - a.rect.right)
      .map(item => item.target);
  }

  function popupCloseControls(popup) {
    const visual = closeImageCandidates(popup);
    if (visual.length) return visual;
    const selector = "button, input[type='button'], input[type='submit'], input[type='image'], a, [role='button'], [onclick], [tabindex], img, svg, i";
    const candidates = [...popup.querySelectorAll(selector)]
      .filter(element => root.BaixaNavigation.visible(element) && !element.disabled && isCloseControl(element))
      .map(element => element.matches("img, svg, i")
        ? element.closest("a, button, input[type='image'], [onclick], [role='button'], [tabindex]") || element
        : element);
    return [...new Set(candidates)];
  }

  function findCloseControlNearPopup(popup) {
    const doc = popup?.ownerDocument;
    const popupRect = popup?.getBoundingClientRect?.();
    if (!doc || !popupRect) return null;
    const selector = "button, input[type='button'], input[type='image'], a, [role='button'], [onclick], [tabindex], img, svg, i";
    const candidates = [];
    for (const element of doc.querySelectorAll(selector)) {
      if (!root.BaixaNavigation.visible(element) || element.disabled) continue;
      const visual = element.matches("img, svg, i") ? element : element.querySelector?.("img, svg, i");
      const target = visual?.closest?.("a, button, input[type='image'], [onclick], [role='button'], [tabindex]") || element;
      const rect = (visual || target).getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const metadata = popupControlMetadata(target) + " " + popupControlMetadata(visual);
      const nearTopRight = rect.top <= popupRect.top + 85 && rect.right >= popupRect.right - 90 && rect.left >= popupRect.right - 120;
      const tiny = rect.width <= 60 && rect.height <= 60;
      const named = /fechar|fecha|close|dismiss|btnclose|closebutton|botao x|fechar\.(?:gif|png)/i.test(metadata);
      const symbol = /(?:^|[\s:._-])(?:x|×|✕|✖|✗|✘)(?:$|[\s:._-])/iu.test(metadata);
      if (nearTopRight && tiny || named || symbol) {
        const score = (nearTopRight ? 130 : 0) + (tiny ? 45 : 0) + (named ? 35 : 0) + (symbol ? 30 : 0);
        candidates.push({ element: target, score, distance: Math.abs(rect.right - popupRect.right) + Math.abs(rect.top - popupRect.top) });
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
    return candidates[0]?.element || null;
  }

  function selectBestPopupCloseControl(popup) {
    const visual = closeImageCandidates(popup);
    if (visual.length) return visual[0];
    const candidates = popupCloseControls(popup);
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) return findCloseControlNearPopup(popup);
    const rootRect = popup.getBoundingClientRect?.();
    if (!rootRect) return null;
    const ranked = candidates.map(element => {
      const rect = element.getBoundingClientRect?.() || {};
      const metadata = popupControlMetadata(element);
      const topRight = Number.isFinite(rect.right) && rect.right >= rootRect.right - 70 && rect.top <= rootRect.top + 80;
      const small = rect.width > 0 && rect.width <= 60 && rect.height > 0 && rect.height <= 60;
      const named = /fechar|fecha|close|dismiss|btnclose|closebutton|botao x/i.test(metadata);
      const symbol = /(?:^|[\s:._-])(?:x|×|✕|✖|✗|✘)(?:$|[\s:._-])/iu.test(metadata);
      const score = (topRight ? 100 : 0) + (small ? 40 : 0) + (named ? 30 : 0) + (symbol ? 30 : 0);
      return { element, score };
    }).sort((a, b) => b.score - a.score);
    return ranked[0]?.score > 0 ? ranked[0].element : null;
  }

  // Extrai o nome da função de um href "javascript:nomeDaFuncao()" simples.
  // Qualquer outra expressão é ignorada: a extensão nunca avalia código livre.
  function safeCloseFunctionName(control) {
    const href = String(control?.getAttribute?.("href") || "").trim();
    if (!/^javascript:/i.test(href)) return "";
    const expression = href.replace(/^javascript:/i, "").trim();
    const match = expression.match(/^(?:(?:window|self)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?$/i);
    return match ? match[1] : "";
  }

  function invokeSafeJavaScriptClose(control) {
    const functionName = safeCloseFunctionName(control);
    if (!functionName) return false;
    const view = control.ownerDocument?.defaultView;
    if (!view) return false;
    if (functionName.toLowerCase() === "close") {
      if (!view.opener) return false;
      view.close();
      return true;
    }
    // Content scripts vivem em um mundo isolado e normalmente não enxergam as
    // funções da página; nesse caso o fechamento é feito por pageCloseRequest().
    const handler = view[functionName];
    if (typeof handler !== "function") return false;
    handler.call(view);
    return true;
  }

  function richFacesPanelId(control, popup) {
    const snippets = [
      control?.getAttribute?.("onclick"), control?.getAttribute?.("href"), control?.onclick?.toString?.(),
      popup?.getAttribute?.("onclick"), popup?.id
    ].filter(Boolean).join(" ");
    // Somente a chamada nativa já presente na página é reconhecida.
    return snippets.match(/richfaces?\s*\.\s*hideModalPanel\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/i)?.[1] || "";
  }

  function invokeRichFacesModalClose(control, popup) {
    const view = control.ownerDocument?.defaultView || popup?.ownerDocument?.defaultView;
    const richFaces = view?.RichFaces || view?.Richfaces;
    if (typeof richFaces?.hideModalPanel !== "function") return false;
    const panelId = richFacesPanelId(control, popup);
    if (!panelId) return false;
    richFaces.hideModalPanel(panelId);
    return true;
  }

  // Descreve o fechamento seguro que precisa rodar no mundo da própria página.
  function pageCloseRequest(control, popup) {
    const panelId = richFacesPanelId(control, popup);
    if (panelId) return { kind: "richfaces", value: panelId };
    const functionName = safeCloseFunctionName(control);
    if (functionName && functionName.toLowerCase() !== "close") return { kind: "function", value: functionName };
    return null;
  }

  // O mundo isolado do content script não acessa RichFaces nem funções da
  // página, e um href javascript: é bloqueado pela CSP. O background executa a
  // chamada simples no mundo MAIN via chrome.scripting (permitido pela CSP).
  function requestPageClose(request) {
    const runtime = root.chrome?.runtime;
    if (!request || !runtime?.sendMessage) return Promise.resolve(false);
    return new Promise(resolve => {
      try {
        runtime.sendMessage({ type: "PAGE_CLOSE_POPUP", ...request }, response => {
          void runtime.lastError;
          resolve(response?.ok === true && response.closed === true);
        });
      } catch { resolve(false); }
    });
  }

  // Impede que o clique em <a href="javascript:..."> dispare a navegação
  // bloqueada pela CSP (erro "Running the JavaScript URL violates..."). Os
  // manipuladores onclick continuam executando normalmente.
  function suppressJavascriptNavigation(control) {
    if (!/^javascript:/i.test(String(control?.getAttribute?.("href") || "").trim())) return () => {};
    const guard = event => event.preventDefault();
    control.addEventListener("click", guard);
    return () => control.removeEventListener("click", guard);
  }

  function popupClosedAfterClick(popup, control, previousMessage = "") {
    if (!popup) return true;
    if (!root.BaixaNavigation.visible(popup)) return true;
    // RichFaces pode manter o painel no DOM enquanto o conteúdo é trocado por
    // um loader. Nesse momento o popup já foi fechado para fins da automação.
    if (control && !root.BaixaNavigation.visible(control)) return true;
    const controls = popupCloseControls(popup).filter(root.BaixaNavigation.visible);
    if (!controls.length) {
      const current = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(popup));
      if (!current) return true;
      // Se o painel foi reaproveitado pelo SIGITM para exibir o loader, o texto
      // original da mensagem desaparece antes do painel sair do DOM. Isso já é
      // fechamento suficiente para a automação avançar.
      if (previousMessage && !current.includes(previousMessage)) return true;
      if (previousMessage && current !== previousMessage && /loader|loading|aguarde|processando|carregando/.test(current)) return true;
    }
    return false;
  }

  async function clickPopupClose(control, popup, shouldStop = () => false) {
    const href = String(control?.getAttribute?.("href") || "").trim();
    const javascriptHref = /^javascript:/i.test(href);
    if (!control) throw new Error("Controle X do popup não encontrado.");
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    const previousMessage = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(popup));
    try { control.focus?.(); } catch { /* foco não é essencial */ }
    try {
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: control.ownerDocument?.defaultView || window }));
      control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: control.ownerDocument?.defaultView || window }));
    } catch { /* alguns controles antigos não expõem MouseEvent */ }
    const releaseNavigationGuard = suppressJavascriptNavigation(control);
    try { control.click?.(); } catch { /* tentamos os fechamentos nativos abaixo */ }
    finally { releaseNavigationGuard(); }
    if (await waitFor(() => popupClosedAfterClick(popup, control, previousMessage), 2200, shouldStop, 25)) return;
    if (invokeRichFacesModalClose(control, popup)) {
      if (await waitFor(() => popupClosedAfterClick(popup, control, previousMessage), 2200, shouldStop, 25)) return;
    }
    if (invokeSafeJavaScriptClose(control)) {
      if (await waitFor(() => popupClosedAfterClick(popup, control, previousMessage), 2200, shouldStop, 25)) return;
    }
    if (await requestPageClose(pageCloseRequest(control, popup))) {
      if (await waitFor(() => popupClosedAfterClick(popup, control, previousMessage), 2200, shouldStop, 25)) return;
    }
    if (await waitFor(() => popupClosedAfterClick(popup, control, previousMessage), 3200, shouldStop, 35)) return;
    if (javascriptHref) throw new Error("O X do SIGITM não fechou o popup.");
    throw new Error("O X do SIGITM não foi confirmado como fechado; a automação não avançará sem segurança.");
  }

  async function closeBlockPopup(shouldStop = () => false, action = "Bloquear") {
    const popup = await waitFor(() => visiblePopups().find(candidate => {
      const text = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(candidate));
      return Boolean(selectBestPopupCloseControl(candidate)) || Boolean(text && /tiquete bloqueado|baixa|mensagem|erro/.test(text));
    }) || null, 7000, shouldStop, 40);
    if (!popup) return false;
    const message = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(popup));
    if (/erro.{0,60}(log|baixa)|falha.{0,60}(log|baixa)|log.{0,60}(erro|falha)/.test(message)) {
      throw new Error(`Popup de erro após ${action}; fluxo cancelado: ${root.BaixaNavigation.textOf(popup)}`);
    }
    const control = await waitFor(() => {
      if (!root.BaixaNavigation.visible(popup)) return true;
      const current = visiblePopups().find(candidate => candidate === popup || candidate.contains?.(popup) || popup.contains?.(candidate)) || popup;
      return selectBestPopupCloseControl(current) || findCloseControlNearPopup(current) || false;
    }, 7000, shouldStop, 35);
    if (!root.BaixaNavigation.visible(popup)) return true;
    if (!control || control === true) {
      // O SIGITM pode iniciar a animação de fechamento antes de o detector
      // conseguir ler o X. Nesse caso o popup já está saindo: não transforme
      // um fechamento legítimo em falha.
      return !root.BaixaNavigation.visible(popup);
    }
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    await clickPopupClose(control, popup, shouldStop);
    return true;
  }

  function validationErrorPopup() {
    const requiredError = /Validation Error:\s*Value is required/i;
    const matches = visiblePopups().filter(popup => requiredError.test(root.BaixaNavigation.textOf(popup)));
    return matches.sort((first, second) => {
      const firstControl = selectBestPopupCloseControl(first);
      const secondControl = selectBestPopupCloseControl(second);
      return (firstControl ? 0 : 1) - (secondControl ? 0 : 1);
    })[0] || null;
  }

  async function closeValidationErrorPopup(shouldStop = () => false) {
    const popup = await waitFor(() => validationErrorPopup(), 700, shouldStop, 40);
    if (!popup) return false;
    const control = selectBestPopupCloseControl(popup);
    if (!control) return false;
    await clickPopupClose(control, popup, shouldStop);
    return true;
  }

  async function beginMainClosure(shouldStop = () => false) {
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
    return true;
  }

  async function saveMainClosure(shouldStop = () => false) {
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    const button = findUniqueButton(["Gravar Baixa"]);
    let validationErrorObserved = false;
    let popupCloseObserved = false;
    const rootNode = document.documentElement;
    const validationPattern = /Validation Error:\s*Value is required/i;
    const hasValidationErrorNow = () => root.BaixaNavigation.documents().some(doc =>
      validationPattern.test(root.BaixaNavigation.textOf(doc.body))
    );
    const looksLikeClose = target => {
      let node = target;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if (isCloseControl(node)) return true;
      }
      return false;
    };
    const observer = rootNode && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => { if (hasValidationErrorNow()) validationErrorObserved = true; })
      : null;
    const clickListener = event => {
      if (looksLikeClose(event.target)) {
        popupCloseObserved = true;
        return;
      }
      try {
        const popup = validationErrorPopup();
        if (!popup) return;
        const control = selectBestPopupCloseControl(popup);
        if (control && (event.target === control || control.contains?.(event.target) || event.target?.closest?.("a,button,input,[role='button'],[onclick],[tabindex]") === control)) {
          popupCloseObserved = true;
        }
      } catch { /* clique fora do popup não interfere no fluxo */ }
    };
    try {
      if (observer) observer.observe(rootNode, { subtree: true, childList: true, characterData: true, attributes: true });
      document.addEventListener("click", clickListener, true);
      button.click();
      // Capture both synchronous and asynchronous SIGITM validation. The observer
      // keeps the error known even when the user closes its popup immediately.
      const end = Date.now() + 1200;
      let validationPopupSeen = false;
      while (Date.now() < end) {
        if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
        if (hasValidationErrorNow()) validationErrorObserved = true;
        const visibleValidationPopup = validationErrorPopup();
        if (visibleValidationPopup) validationPopupSeen = true;
        if (validationErrorObserved) return { saved: false, validationError: true, popupCloseObserved };
        if (validationPopupSeen && !visibleValidationPopup && root.BaixaNavigation.findTabCandidates) {
          const hasCertificationTab = root.BaixaNavigation.findTabCandidates("Certificação").length > 0;
          if (hasCertificationTab) return { saved: false, validationError: true, popupCloseObserved: true };
        }
        if (popupCloseObserved && root.BaixaNavigation.findTabCandidates) {
          const hasCertificationTab = root.BaixaNavigation.findTabCandidates("Certificação").length > 0;
          if (hasCertificationTab) return { saved: false, validationError: true, popupCloseObserved: true };
        }
        await root.BaixaHelpers.sleep(50);
      }
      return { saved: true, validationError: false, popupCloseObserved };
    } finally {
      observer?.disconnect();
      document.removeEventListener("click", clickListener, true);
    }
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
    await root.BaixaHelpers.sleep(400);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    return root.BaixaNavigation.documents().some(hasTicketReleased);
  }

  function waitFor(predicate, timeout = 12000, shouldStop = () => false, pollMs = 250) {
    return root.BaixaHelpers.waitFor(predicate, timeout, shouldStop, pollMs);
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

  const api = { findUniqueButton, waitForUniqueButton, isCloseControl, closeImageCandidates, popupCloseControls, findCloseControlNearPopup, selectBestPopupCloseControl, invokeSafeJavaScriptClose, invokeRichFacesModalClose, pageCloseRequest, suppressJavascriptNavigation, clickPopupClose, closeBlockPopup, closeValidationErrorPopup, beginMainClosure, saveMainClosure, waitForTicketReleased, closeActiveAction, confirmMainClosure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaHandler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
