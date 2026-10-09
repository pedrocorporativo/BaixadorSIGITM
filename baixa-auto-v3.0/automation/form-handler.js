(function (root) {
  "use strict";

  function setValue(control, value, options = {}) {
    if (!control) throw new Error("Campo de formulário não encontrado.");
    const label = control.name || control.id || "sem identificação";
    if ((control.disabled || control.readOnly) && !options.allowLocked) {
      const state = control.disabled ? "desabilitado" : "somente leitura";
      throw new Error(`Campo ${label} indisponível: está ${state} no SIGITM.`);
    }
    const originalDisabled = control.disabled;
    const originalReadOnly = control.readOnly;
    if (options.allowLocked) {
      control.disabled = false;
      control.readOnly = false;
    }
    try {
      if (control.tagName === "SELECT") {
        const option = findSelectOption(control, value);
        if (!option) throw new Error(`Opção não encontrada para ${value}.`);
        control.value = option.value;
      } else if (control.type === "checkbox" || control.type === "radio") {
        const expected = root.BaixaNavigation.normalize(value) === "sim";
        control.checked = expected;
      } else {
        const view = control.ownerDocument.defaultView;
        const prototype = control.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (setter) setter.call(control, value);
        else control.value = value;
      }
      const EventType = control.ownerDocument.defaultView.Event;
      control.dispatchEvent(new EventType("input", { bubbles: true }));
      control.dispatchEvent(new EventType("change", { bubbles: true }));
      // Formulários legados do SIGITM confirmam alguns campos somente no blur.
      if (options.blur || options.allowLocked) control.dispatchEvent(new EventType("blur"));
    } finally {
      if (options.allowLocked) {
        control.disabled = originalDisabled;
        control.readOnly = originalReadOnly;
      }
    }
    if (!fieldValueMatches(control, value)) {
      throw new Error(`O campo ${control.name || control.id || "sem identificação"} não confirmou o valor inserido.`);
    }
  }

  function isSaiService(value) {
    const normalized = root.BaixaNavigation.normalize(value);
    return /\bsai\b/.test(normalized) || (normalized.includes("acesso") && normalized.includes("internet"));
  }

  function serviceAbbreviation(value) {
    const match = String(value || "").trim().match(/^([A-Z0-9]{2,6})\s*(?:[-–:]|$)/);
    return match ? root.BaixaNavigation.normalize(match[1]) : "";
  }

  function matchesServiceOption(actual, expected) {
    const actualNormalized = root.BaixaNavigation.normalize(actual);
    const expectedNormalized = root.BaixaNavigation.normalize(expected);
    if (actualNormalized === expectedNormalized) return true;
    const abbreviation = serviceAbbreviation(expected);
    if (abbreviation && new RegExp(`(^| )${abbreviation}($| )`).test(actualNormalized)) return true;
    return isSaiService(expected) && isSaiService(actual);
  }

  function selectOptionText(option) {
    return [option?.textContent, option?.label, option?.value].filter(Boolean).join(" ");
  }

  function findSelectOption(control, value) {
    const expected = root.BaixaNavigation.normalize(value);
    return [...(control?.options || [])].find(option => {
      const text = root.BaixaNavigation.normalize(selectOptionText(option));
      return text === expected || matchesServiceOption(text, value);
    }) || null;
  }

  function fieldValueMatches(control, expected) {
    const actual = root.BaixaNavigation.normalize(root.BaixaNavigation.valueOf(control));
    const wanted = root.BaixaNavigation.normalize(expected);
    return actual === wanted || (control?.tagName === "SELECT" && matchesServiceOption(actual, expected));
  }

  function fill(aliases, value) {
    const controls = controlsForFormField(aliases, true);
    if (controls.length !== 1) {
      const allControls = controlsForFormField(aliases);
      if (!controls.length && allControls.length === 1) {
        setValue(allControls[0], value);
        return;
      }
      throw new Error(`Campo ${aliases[0]} ${controls.length ? "ambíguo" : "não encontrado ou indisponível para edição"}.`);
    }
    setValue(controls[0], value);
  }

  function fillBestEffort(aliases, value, skippedFields, options = {}) {
    const isRepairDate = aliases.some(alias => /^(data|dt)( de)? reparo$/.test(root.BaixaNavigation.normalize(alias)));
    if (isRepairDate && !String(value || "").trim()) {
      throw new Error("Data de Reparo não pôde ser calculada porque a Data Criação está ausente ou inválida.");
    }
    const controls = controlsForFormField(aliases, true);
    if (controls.length === 1) {
      setValue(controls[0], value, options);
      verify(aliases, value);
      return;
    }
    const allControls = controlsForFormField(aliases);
    if (controls.length === 0 && allControls.length === 1 && (allControls[0].disabled || allControls[0].readOnly)) {
      skippedFields.push(aliases[0]);
      return;
    }
    throw new Error(`Campo ${aliases[0]} ${controls.length ? "ambíguo" : "não encontrado"}.`);
  }

  function findRepairDateField() {
    const aliases = ["Data Reparo", "Data de Reparo", "Data do Reparo", "Dt Reparo", "Dt. Reparo"];
    const discovered = new Set(root.BaixaNavigation.controlsFor(aliases).filter(control =>
      !["button", "submit", "image", "checkbox", "radio", "reset"].includes(String(control.type || "").toLowerCase())
    ));
    for (const doc of root.BaixaNavigation.documents()) {
      const controls = [...doc.querySelectorAll("input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='image']):not([type='checkbox']):not([type='radio']), textarea")]
        .filter(control => root.BaixaNavigation.visible(control));
      for (const label of doc.querySelectorAll("label, th, td, span, div")) {
        if (!root.BaixaNavigation.visible(label)) continue;
        const labelText = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(label).replace(/:$/, ""));
        if (!aliases.some(alias => root.BaixaNavigation.normalize(alias) === labelText)) continue;
        const labelRect = label.getBoundingClientRect?.();
        if (!labelRect) continue;
        const nearby = controls.map(control => ({ control, rect: control.getBoundingClientRect?.() }))
          .filter(item => item.rect && item.rect.left >= labelRect.right - 12 &&
            Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) <= 36)
          .sort((first, second) => first.rect.left - second.rect.left);
        if (nearby.length === 1 || (nearby[0] && nearby[1] && nearby[0].rect.left + 12 < nearby[1].rect.left)) {
          discovered.add(nearby[0].control);
        }
      }
    }
    const matches = [...discovered];
    if (matches.length !== 1) {
      throw new Error(`Campo Data de Reparo ${matches.length ? `ambíguo (${matches.length} campos)` : "não encontrado na aba Encerramento"}.`);
    }
    return matches[0];
  }

  async function waitForRepairDateField(shouldStop = () => false, timeout = 7000) {
    const end = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      try { return findRepairDateField(); }
      catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw lastError || new Error("Campo Data de Reparo não encontrado na aba Encerramento.");
  }

  function repairDateValueForControl(control, value) {
    const parsed = root.BaixaDateHandler.parseDate(value);
    if (!parsed) throw new Error("Data de Reparo calculada possui formato inválido.");
    const pad = part => String(part).padStart(2, "0");
    const date = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
    if (control.type === "date") return date;
    if (control.type === "datetime-local") return `${date}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
    return value;
  }

  async function fillRepairDate(value, shouldStop = () => false) {
    if (!String(value || "").trim()) throw new Error("Data de Reparo não pôde ser calculada porque a Data Criação está ausente ou inválida.");
    const field = await waitForRepairDateField(shouldStop);
    const expected = repairDateValueForControl(field, value);
    // O SIGITM pode marcar Data Reparo como readonly/disabled porque normalmente
    // espera interação com o calendário. Como este campo específico é localizado
    // pelo rótulo e a data já foi validada, atualize-o via setter nativo e eventos.
    setValue(field, expected, { allowLocked: true });
    const expectedTime = root.BaixaDateHandler.parseDate(value).getTime();
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      let current;
      try { current = findRepairDateField(); } catch { current = field; }
      const actualDate = root.BaixaDateHandler.parseDate(root.BaixaNavigation.valueOf(current));
      const requestedDate = root.BaixaDateHandler.parseDate(value);
      const matches = current.type === "date"
        ? actualDate && requestedDate && actualDate.getFullYear() === requestedDate.getFullYear() &&
          actualDate.getMonth() === requestedDate.getMonth() && actualDate.getDate() === requestedDate.getDate()
        : actualDate?.getTime() === expectedTime;
      if (matches) return true;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Data de Reparo não permaneceu no campo após preenchimento: ${value}.`);
  }

  function verify(aliases, expected) {
    const controls = controlsForFormField(aliases, true);
    if (controls.length !== 1 || !fieldValueMatches(controls[0], expected)) {
      throw new Error(`Validação do campo ${aliases[0]} falhou.`);
    }
  }

  function controlsForFormField(aliases, editableOnly = false) {
    const found = new Set(root.BaixaNavigation.controlsFor(aliases, editableOnly));
    const wanted = aliases.map(alias => root.BaixaNavigation.normalize(alias.replace(/:$/, "")));
    for (const doc of root.BaixaNavigation.documents()) {
      const rows = [...doc.querySelectorAll("tr, [role='row'], .form-group, fieldset, li")]
        .filter(row => root.BaixaNavigation.visible(row));
      for (const row of rows) {
        const rowText = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(row));
        if (!wanted.some(label => rowText.includes(label))) continue;
        const controls = [...row.querySelectorAll("input, select, textarea")].filter(control =>
          root.BaixaNavigation.visible(control) && control.type !== "hidden" &&
          (!editableOnly || (!control.disabled && !control.readOnly))
        );
        if (controls.length === 1) found.add(controls[0]);
      }

      // Alguns formulários legados do SIGITM deixam o rótulo em uma célula/contêiner
      // vizinho ao controle, sem uma linha de formulário identificável.
      for (const label of doc.querySelectorAll("label, th, td, span, div")) {
        if (!root.BaixaNavigation.visible(label)) continue;
        const labelText = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(label).replace(/:$/, ""));
        if (!wanted.some(name => labelText === name || labelText.startsWith(`${name} `))) continue;
        const container = label.closest("tr, [role='row'], .form-group, fieldset, li") || label.parentElement;
        const controls = [...(container?.querySelectorAll("input, select, textarea") || [])].filter(control =>
          root.BaixaNavigation.visible(control) && control.type !== "hidden" &&
          (!editableOnly || (!control.disabled && !control.readOnly))
        );
        if (controls.length === 1) found.add(controls[0]);
      }
    }
    return [...found];
  }

  function isYellowField(control) {
    const style = control.ownerDocument?.defaultView?.getComputedStyle?.(control);
    const color = String(style?.backgroundColor || control.style?.backgroundColor || "");
    const match = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return false;
    const [, red, green, blue] = match.map(Number);
    // Campos editáveis do Encerramento usam amarelo-claro; os campos históricos
    // “Baixado por/Encerrado por” permanecem brancos e não devem ser modificados.
    return red >= 225 && green >= 225 && blue <= 235;
  }

  function closurePhoneControls() {
    const all = controlsForFormField(["Telefone"]);
    const editable = all.filter(control => !control.disabled && !control.readOnly);
    const yellow = editable.filter(isYellowField);
    const controls = yellow.length === 2 || yellow.length === 3 ? yellow : editable.length === 2 ? editable : null;
    if (!controls) {
      throw new Error(`Não foi possível identificar os campos Telefone do Encerramento. Editáveis encontrados: ${editable.length}; amarelos encontrados: ${yellow.length}; esperado: 2 controles legados ou 3 controles amarelos (DDD, número e segundo telefone).`);
    }
    return [...controls].sort((first, second) => {
      const firstRect = first.getBoundingClientRect?.() || { top: 0, left: 0 };
      const secondRect = second.getBoundingClientRect?.() || { top: 0, left: 0 };
      return firstRect.top - secondRect.top || firstRect.left - secondRect.left;
    });
  }

  function phoneValuesForLayout(intragov, count) {
    if (count === 2 && !intragov) return ["xx", "xx"];
    // Com Intragov, o primeiro Telefone muda para dois inputs: DDD e número.
    // O terceiro input continua sendo o segundo Telefone do Encerramento.
    if (count === 3 && intragov) return ["00", "000000000", "xx"];
    if (count === 3 && !intragov) return ["xx", "xx", "xx"];
    if (count === 2 && intragov) {
      throw new Error("Intragov marcado, mas o primeiro Telefone não apresentou as caixas de DDD e número. Gravar Baixa cancelado.");
    }
    throw new Error(`Layout de Telefone não suportado: ${count} controles identificados.`);
  }

  function fillPhones(intragov) {
    const controls = closurePhoneControls();
    const values = phoneValuesForLayout(intragov, controls.length);
    const skipped = [];
    controls.forEach((control, index) => {
      if (control.disabled || control.readOnly) skipped.push(`Telefone ${index + 1}`);
      else setValue(control, values[index], { blur: true });
    });
    return skipped;
  }

  function verifyClosureValues(intragov) {
    verify(["Descrição"], "xx");
    verify(["Técnico"], "xx");
    verify(["Área Técnica"], "xx");
    verify(["Responsável"], "xx");
    const phoneControls = closurePhoneControls();
    const expectedPhones = phoneValuesForLayout(intragov, phoneControls.length);
    phoneControls.forEach((control, index) => {
      const actual = root.BaixaNavigation.normalize(root.BaixaNavigation.valueOf(control));
      const expected = root.BaixaNavigation.normalize(expectedPhones[index]);
      if (actual !== expected) {
        throw new Error(`Telefone ${index + 1} do Encerramento não confirmou o valor ${expectedPhones[index]} (valor atual: ${root.BaixaNavigation.valueOf(control) || "vazio"}). Gravar Baixa cancelado.`);
      }
    });
    return true;
  }

  async function waitForClosureValues(intragov, shouldStop = () => false, timeout = 3000) {
    const end = Date.now() + timeout;
    let lastError;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      try {
        verifyClosureValues(intragov);
        return true;
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`Encerramento não confirmou todos os campos após preencher: ${lastError?.message || "valores não persistiram no formulário"}`);
  }

  function findBaixaCodeField() {
    const aliases = ["Código Completo da Baixa", "Código Completo Baixa", "Código da Baixa", "Código Baixa"];
    const exact = root.BaixaNavigation.controlsFor(aliases);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error("Campo Código Completo da Baixa ambíguo.");

    const docs = root.BaixaNavigation.documents();
    const discovered = new Set();
    for (const doc of docs) {
      const controls = [...doc.querySelectorAll("input:not([type='hidden']), textarea, select")]
        .filter(control => root.BaixaNavigation.visible(control));
      for (const control of controls) {
        const metadata = root.BaixaNavigation.normalize([
          control.id, control.name, control.title, control.getAttribute("aria-label"),
          ...(control.labels ? [...control.labels].map(root.BaixaNavigation.textOf) : [])
        ].filter(Boolean).join(" "));
        if (/codigo(?: completo)?(?: da)? baixa|baixa.*codigo/.test(metadata)) discovered.add(control);

        const row = control.closest("tr, [role='row'], .form-group, fieldset, li") || control.parentElement;
        if (!row || !root.BaixaNavigation.visible(row)) continue;
        const rowLabel = root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(row));
        if (!/codigo(?: completo)?(?: da)? baixa/.test(rowLabel)) continue;
        const rowControls = [...row.querySelectorAll("input:not([type='hidden']), textarea, select")]
          .filter(item => root.BaixaNavigation.visible(item));
        if (rowControls.length === 1) discovered.add(control);
      }
    }
    const matches = [...discovered];
    if (matches.length !== 1) {
      throw new Error(`Campo Código Completo da Baixa ${matches.length ? `ambíguo (${matches.length} campos)` : "não encontrado na aba Encerramento"}.`);
    }
    return matches[0];
  }

  async function waitForBaixaCodeField(shouldStop = () => false, timeout = 7000) {
    const end = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      try { return findBaixaCodeField(); }
      catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw lastError || new Error("Campo Código Completo da Baixa não encontrado na aba Encerramento.");
  }

  async function fillBaixaCode(code, skippedFields, search = true, shouldStop = () => false) {
    const field = findBaixaCodeField();
    if (!field.disabled && !field.readOnly) {
      setValue(field, code);
      if (root.BaixaNavigation.normalize(root.BaixaNavigation.valueOf(field)) !== root.BaixaNavigation.normalize(code)) {
        throw new Error("O campo Código Completo da Baixa não confirmou o código inserido.");
      }
    } else {
      skippedFields.push("Código Completo da Baixa (campo controlado pelo SIGITM)");
    }
    if (search) await clickBaixaCodeLookup(code, shouldStop);
  }

  async function clickLookupAdjacentTo(field, label, shouldStop = () => false) {
    const fieldRect = field.getBoundingClientRect();
    const selector = "button, input[type='button'], input[type='submit'], input[type='image'], a, [role='button'], [onclick], [tabindex], img, svg, i";
    const candidates = root.BaixaNavigation.documents().flatMap(doc => [...doc.querySelectorAll(selector)]).filter(element =>
      root.BaixaNavigation.visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true"
    ).map(element => {
      const image = element.matches("img, svg, i") ? element : element.querySelector?.("img, svg, i");
      const clickable = element.matches("img, svg, i")
        ? element.closest("button, a, [role='button'], [onclick], [tabindex]") || element
        : element;
      const style = element.ownerDocument.defaultView?.getComputedStyle?.(image || element);
      const identity = root.BaixaNavigation.normalize([
        element.id, element.name, element.className, element.value, element.title, element.alt,
        element.getAttribute("aria-label"), element.getAttribute("src"), element.getAttribute("onclick"),
        style?.backgroundImage, image?.id, image?.className, image?.src, image?.alt, image?.title,
        image?.getAttribute("src"), image?.getAttribute("onclick"), root.BaixaNavigation.textOf(element)
      ].filter(Boolean).join(" "));
      const rect = (image || element).getBoundingClientRect();
      const adjacent = rect.left >= fieldRect.right - 12 && rect.left <= fieldRect.right + 90 &&
        Math.abs((rect.top + rect.bottom) / 2 - (fieldRect.top + fieldRect.bottom) / 2) <= 32 &&
        rect.width > 0 && rect.width <= 48 && rect.height > 0 && rect.height <= 48;
      const semantic = /lupa|buscar|pesquisar|consultar|localizar|search|lookup|magnif/.test(identity);
      return { element: clickable, semantic, adjacent, distance: Math.abs(rect.left - fieldRect.right) +
        Math.abs((rect.top + rect.bottom) / 2 - (fieldRect.top + fieldRect.bottom) / 2) };
    });
    const dedupe = items => [...new Map(items.map(item => [item.element, item])).values()];
    let unique = dedupe(candidates.filter(item => item.semantic));
    if (unique.length !== 1) unique = dedupe(candidates.filter(item => item.adjacent));
    if (unique.length > 1) {
      unique.sort((a, b) => a.distance - b.distance);
      if (unique[0].distance + 4 < unique[1].distance) unique = [unique[0]];
    }
    if (unique.length !== 1) throw new Error(`Lupa do campo ${label} ${unique.length ? "ambígua" : "não encontrada ao lado do campo"}.`);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    unique[0].element.click();
    return true;
  }

  async function clickBaixaCodeLookup(code, shouldStop = () => false) {
    const field = findBaixaCodeField();
    if (field.disabled || field.readOnly) {
      // SIGITM pode preencher o campo por meio da janela de pesquisa quando o campo é readonly.
    } else {
      setValue(field, code);
    }
    return clickLookupAdjacentTo(field, "Código Completo da Baixa", shouldStop);
  }

  function findDiagnosisField() {
    const discovered = new Set(controlsForFormField(["Diagnóstico", "Diagnostico"]));
    for (const doc of root.BaixaNavigation.documents()) {
      const controls = [...doc.querySelectorAll("input:not([type='hidden']), textarea, select")]
        .filter(control => root.BaixaNavigation.visible(control));
      for (const control of controls) {
        const metadata = root.BaixaNavigation.normalize([
          control.id, control.name, control.title, control.getAttribute("aria-label"),
          ...(control.labels ? [...control.labels].map(root.BaixaNavigation.textOf) : [])
        ].filter(Boolean).join(" "));
        if (/diagnostic/.test(metadata)) discovered.add(control);
      }

      // No layout antigo, o texto “Diagnóstico:” e o input ficam em células
      // diferentes. Usamos apenas o campo à direita do rótulo, na mesma altura.
      for (const label of doc.querySelectorAll("label, th, td, span, div")) {
        if (!root.BaixaNavigation.visible(label) || root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(label).replace(/:$/, "")) !== "diagnostico") continue;
        const labelRect = label.getBoundingClientRect?.();
        if (!labelRect) continue;
        const nearby = controls.map(control => ({ control, rect: control.getBoundingClientRect?.() }))
          .filter(item => item.rect && item.rect.left >= labelRect.right - 12 &&
            Math.abs((item.rect.top + item.rect.bottom) / 2 - (labelRect.top + labelRect.bottom) / 2) <= 34)
          .sort((first, second) => first.rect.left - second.rect.left);
        if (nearby.length === 1 || (nearby[0] && nearby[1] && nearby[0].rect.left + 12 < nearby[1].rect.left)) discovered.add(nearby[0].control);
      }
    }
    const matches = [...discovered];
    if (matches.length !== 1) throw new Error(`Campo Diagnóstico ${matches.length ? `ambíguo (${matches.length} campos)` : "não encontrado na aba Definição"}.`);
    return matches[0];
  }

  async function waitForDiagnosisField(shouldStop = () => false, timeout = 7000) {
    const end = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      try { return findDiagnosisField(); }
      catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw lastError || new Error("Campo Diagnóstico não encontrado na aba Definição.");
  }

  async function selectDiagnosisFromLookup(diagnosis, shouldStop = () => false, diagnosisField = null) {
    const code = String(diagnosis || "").match(/\d{8}/)?.[0];
    if (!code) throw new Error("Diagnóstico definido pelas regras não possui código de oito dígitos.");
    const wanted = root.BaixaNavigation.normalize(code);
    const end = Date.now() + 7000;
    let candidates = [];
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      candidates = root.BaixaNavigation.documents().flatMap(doc => [...doc.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], [onclick], [tabindex]")])
        .filter(element => root.BaixaNavigation.visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true")
        .filter(element => root.BaixaNavigation.normalize(root.BaixaNavigation.textOf(element) || element.value || element.getAttribute("aria-label")) === wanted);
      candidates = [...new Set(candidates)];
      if (candidates.length === 1) break;
      if (candidates.length > 1) throw new Error(`Diagnóstico ${code} ambíguo na janela de pesquisa.`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (candidates.length !== 1) throw new Error(`Diagnóstico ${code} não encontrado na janela de pesquisa.`);
    candidates[0].click();
    const field = diagnosisField || await waitForDiagnosisField(shouldStop);
    const description = String(diagnosis).replace(code, "").trim();
    // O SIGITM pode substituir o input ao fechar a janela de pesquisa. Rebusque
    // o controle a cada tentativa para não validar uma referência DOM obsoleta.
    const confirmed = await waitForFieldValue(() => {
      try { return findDiagnosisField(); }
      catch { return field; }
    }, [code, description], 3500, shouldStop);
    if (!confirmed) throw new Error(`Diagnóstico ${code} / ${description} não foi confirmado no campo após a seleção.`);
    return true;
  }

  async function waitForFieldValue(field, expectedParts, timeout, shouldStop) {
    const expected = (Array.isArray(expectedParts) ? expectedParts : [expectedParts])
      .map(root.BaixaNavigation.normalize).filter(Boolean);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      const currentField = typeof field === "function" ? field() : field;
      const actual = root.BaixaNavigation.normalize(root.BaixaNavigation.valueOf(currentField));
      if (expected.some(value => actual.includes(value))) return true;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
  }

  async function fillDiagnosis(decision, shouldStop = () => false) {
    if (!await root.BaixaNavigation.clickTab("Definição", shouldStop) || shouldStop()) throw new Error("Automação interrompida.");
    const skipped = [];
    const field = await waitForDiagnosisField(shouldStop);
    if (field.disabled || field.readOnly) skipped.push("Diagnóstico");
    else setValue(field, decision.diagnostico);
    await clickLookupAdjacentTo(field, "Diagnóstico", shouldStop);
    await selectDiagnosisFromLookup(decision.diagnostico, shouldStop, field);
    return skipped;
  }

  async function fillClosure(decision, intragov, dataReparo, shouldStop = () => false, searchBaixaCode = true) {
    const skippedFields = [];
    if (!await root.BaixaNavigation.clickTab("Encerramento", shouldStop) || shouldStop()) throw new Error("Automação interrompida.");
    if (searchBaixaCode) {
      const field = await waitForBaixaCodeField(shouldStop);
      if (!field.disabled && !field.readOnly) {
        setValue(field, decision.codigoBaixa);
        if (root.BaixaNavigation.normalize(root.BaixaNavigation.valueOf(field)) !== root.BaixaNavigation.normalize(decision.codigoBaixa)) {
          throw new Error("O campo Código Completo da Baixa não confirmou o código inserido.");
        }
      } else {
        skippedFields.push("Código Completo da Baixa (campo controlado pelo SIGITM)");
      }
      await clickBaixaCodeLookup(decision.codigoBaixa, shouldStop);
    } else {
      await fillBaixaCode(decision.codigoBaixa, skippedFields, false, shouldStop);
    }
    await fillRepairDate(dataReparo, shouldStop);
    // Campos amarelos do Encerramento, conforme o procedimento SEDUC.
    fillBestEffort(["Descrição"], "xx", skippedFields, { blur: true });
    fillBestEffort(["Técnico"], "xx", skippedFields, { blur: true });
    fillBestEffort(["Área Técnica"], "xx", skippedFields, { blur: true });
    // Intragov é lido na aba Definição e determina o formato dos Telefones.
    // Não existe um campo Intragov no Encerramento, portanto ele não deve ser
    // procurado ou alterado nesta aba.
    // A ordem dos campos Telefone acompanha o formulário: o primeiro fica acima
    // de Data Reparo e o segundo fica na seção "Baixado Com".
    skippedFields.push(...fillPhones(intragov));
    fillBestEffort(["Responsável"], "xx", skippedFields, { blur: true });
    await waitForClosureValues(intragov, shouldStop);

    return [...new Set(skippedFields)];
  }


  function validationErrorText() {
    const pattern = /Validation Error:\s*Value is required/i;
    const texts = root.BaixaNavigation.documents().flatMap(doc => {
      const body = doc.body;
      if (!body || !root.BaixaNavigation.visible(body)) return [];
      return [root.BaixaNavigation.textOf(body)];
    });
    return texts.find(text => pattern.test(text)) || "";
  }

  function hasRequiredValidationError() {
    return Boolean(validationErrorText());
  }

  function certificationLabel(select) {
    const clean = text => String(text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    try {
      if (select.id) {
        const byFor = [...select.ownerDocument.querySelectorAll("label[for]")].find(label => label.getAttribute("for") === select.id);
        if (byFor && clean(byFor.innerText)) return clean(byFor.innerText);
      }
      const cell = select.closest?.("td, th");
      const prev = cell?.previousElementSibling;
      if (prev && !prev.querySelector?.("select") && clean(prev.innerText)) return clean(prev.innerText);
      const wrapPrev = select.parentElement?.previousElementSibling;
      if (wrapPrev && !wrapPrev.querySelector?.("select") && clean(wrapPrev.innerText)) return clean(wrapPrev.innerText);
    } catch { /* rótulo é apenas diagnóstico */ }
    return clean(select.getAttribute?.("aria-label") || select.title || select.name || select.id);
  }

  // Respostas fixas da aba Certificação, por rótulo do campo. Somente estes
  // campos são lidos e preenchidos; qualquer outro select da aba é ignorado.
  const CERTIFICATION_ANSWERS = [
    { label: "Circuito é passível de gerência?", key: "circuito e passivel de gerencia", answer: "Não" },
    { label: "Medições", key: "medicoes", answer: "Não" },
    { label: "Roteador", key: "roteador", answer: "Não se aplica" },
    { label: "Gerência de Modem", key: "gerencia de modem", answer: "Não se aplica" },
    { label: "Modem Cliente", key: "modem cliente", answer: "Não se aplica" },
    { label: "TX", key: "tx", answer: "Não se aplica" },
    { label: "DG", key: "dg", answer: "Não se aplica" }
  ];

  function labelKey(text) {
    return root.BaixaNavigation.normalize(text).replace(/[:?*()]/g, " ").replace(/\s+/g, " ").trim();
  }

  function labelMatches(text, key) {
    const norm = labelKey(text);
    if (!norm) return false;
    return norm === key || (key.length > 3 && norm.includes(key));
  }

  // Localiza o select de um campo: 1) pelo rótulo (label/célula anterior/aria-label);
  // 2) pelo primeiro select que aparece depois do texto do rótulo no documento.
  function findCertificationSelect(key) {
    const nav = root.BaixaNavigation;
    const all = [];
    for (const doc of nav.documents()) {
      for (const select of doc.querySelectorAll("select")) if (nav.visible(select)) all.push({ select, doc });
    }
    const byLabel = all.find(item => labelMatches(certificationLabel(item.select), key));
    if (byLabel) return byLabel.select;
    for (const { doc } of all) {
      try {
        const markers = [...doc.querySelectorAll("label, td, th, span, div, b, strong")]
          .filter(el => !el.querySelector?.("select") && labelMatches(el.textContent || "", key))
          .sort((x, y) => String(x.textContent).length - String(y.textContent).length);
        for (const marker of markers) {
          const next = all.find(item => item.doc === doc && (marker.compareDocumentPosition(item.select) & 4));
          if (next) return next.select;
        }
      } catch { /* sem marcador utilizável neste documento */ }
    }
    return null;
  }

  function certificationSelectState(select, answer) {
    const nav = root.BaixaNavigation;
    const wanted = nav.normalize(answer);
    const option = [...(select.options || [])].find(item => nav.normalize(item.textContent || item.label || item.value || "") === wanted);
    return { option, done: nav.normalize(nav.valueOf(select)) === wanted };
  }

  function answerCertificationSelect(select, option) {
    select.value = option.value;
    const view = select.ownerDocument?.defaultView;
    const EventType = view?.Event || Event;
    for (const type of ["input", "change", "blur"]) select.dispatchEvent(new EventType(type, { bubbles: true }));
  }

  // Preenche na aba Certificação somente os campos de CERTIFICATION_ANSWERS.
  // Não há mais preenchimento genérico de "Selecione um item/status da lista".
  async function fixCertificationValidation(shouldStop = () => false) {
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    if (!await root.BaixaNavigation.clickTab("Certificação", shouldStop)) {
      throw new Error("Aba Certificação não encontrada durante a validação do formulário.");
    }
    const nav = root.BaixaNavigation;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + 12000;
    let changed = 0;
    let lastProblem = "";
    // O SIGITM pode recarregar a aba a cada resposta: responde um campo por vez,
    // espera estabilizar e relê todos antes de concluir.
    while (Date.now() < deadline) {
      if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
      let pending = null;
      const problems = [];
      for (const entry of CERTIFICATION_ANSWERS) {
        const select = findCertificationSelect(entry.key);
        if (!select) { problems.push(`${entry.label}: campo não encontrado`); continue; }
        if (select.disabled || select.readOnly) continue;
        const state = certificationSelectState(select, entry.answer);
        if (state.done) continue;
        if (!state.option) {
          const options = [...(select.options || [])].map(item => String(item.textContent || "").trim()).filter(Boolean).join(" | ");
          problems.push(`${entry.label}: opção '${entry.answer}' inexistente [${options}]`);
          continue;
        }
        pending = { select, option: state.option };
        break;
      }
      lastProblem = problems.join("; ");
      if (pending) {
        answerCertificationSelect(pending.select, pending.option);
        changed++;
        await sleep(250);
        continue;
      }
      if (!problems.length) {
        await sleep(350);
        const stable = CERTIFICATION_ANSWERS.every(entry => {
          const select = findCertificationSelect(entry.key);
          return !select || select.disabled || select.readOnly || certificationSelectState(select, entry.answer).done;
        });
        if (stable) return { changed, remaining: 0, sawRequiredStatus: true };
        continue;
      }
      await sleep(120);
    }
    throw new Error(`Não foi possível preencher a aba Certificação. ${lastProblem}`.trim());
  }

  async function prepareCertificationForSave(shouldStop = () => false) {
    const certification = await fixCertificationValidation(shouldStop);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    if (!await root.BaixaNavigation.clickTab("Encerramento", shouldStop)) {
      throw new Error("Não foi possível voltar à aba Encerramento após validar a Certificação.");
    }
    return certification;
  }

  const api = { hasRequiredValidationError, fixCertificationValidation, prepareCertificationForSave, setValue, fill, verify, fillBestEffort, findRepairDateField, waitForRepairDateField, fillRepairDate, controlsForFormField, isYellowField, closurePhoneControls, phoneValuesForLayout, fillPhones, findBaixaCodeField, waitForBaixaCodeField, fillBaixaCode, clickLookupAdjacentTo, clickBaixaCodeLookup, findDiagnosisField, waitForDiagnosisField, selectDiagnosisFromLookup, fillDiagnosis, fillClosure };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaFormHandler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
