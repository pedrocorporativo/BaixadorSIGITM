(() => {
  "use strict";
  if (window.top !== window || !/sigitm\.redecorp\.br$/i.test(location.hostname)) return;
  const CONTENT_PROTOCOL = "baixa-controller-v8";
  const controllerKey = "__BAIXADOR_AUTOMATICO_V8__";
  if (globalThis[controllerKey]) return;
  globalThis[controllerKey] = true;

  let stopRequested = false;
  let processing = false;
  let currentRunId = "";
  let queuedRunId = "";
  let queuedBatch = null;

  const stopCheck = () => stopRequested;
  const norm = value => BaixaHelpers.normalizeText(value);
  const notify = (message, type = "info") => {
    BaixaNotifications.show(message, type);
    chrome.runtime.sendMessage({
      type: "AUTOMATION_STATUS",
      runId: currentRunId,
      status: type,
      message: String(message || "")
    }, () => void chrome.runtime.lastError);
  };

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error || "Falha na comunicação da extensão."));
      else resolve(response);
    }));
  }

  function sendFinal(record) {
    return sendRuntimeMessage({ type: "RECORD_FINAL_RESULT", runId: currentRunId, record }).catch(() => undefined);
  }

  function sendBatchTicketResult(batch, result) {
    if (!batch?.batchId) return Promise.resolve();
    return sendRuntimeMessage({ type: "BATCH_TICKET_FINISHED", batchId: batch.batchId, sequence: batch.sequence, ...result });
  }

  async function clickBatchSequence(sequence, doubleClick = false) {
    const wanted = String(sequence);
    for (const doc of BaixaNavigation.documents()) {
      for (const table of doc.querySelectorAll("table")) {
        const rows = [...table.querySelectorAll("tr")];
        const headerIndex = rows.findIndex(row => BaixaBatch.sequenceHeaderIndex([...row.querySelectorAll("th, td")]) >= 0);
        if (headerIndex < 0) continue;
        const headers = [...rows[headerIndex].querySelectorAll("th, td")];
        const seqIndex = BaixaBatch.sequenceHeaderIndex(headers);
        for (const row of rows.slice(headerIndex + 1)) {
          const cell = [...row.querySelectorAll("th, td")][seqIndex];
          if (cell && BaixaBatch.sequenceNumber(cell) === wanted && BaixaNavigation.visible(cell)) {
            const target = cell.querySelector("a, button, [role='link'], [onclick], [tabindex]") || cell;
            const link = target.closest?.("a") || cell.querySelector("a");
            const rawHref = String(link?.getAttribute("href") || "").trim();
            const clickHandler = String(link?.getAttribute("onclick") || target.getAttribute?.("onclick") || "");
            const openUrl = clickHandler.match(/(?:window\s*\.\s*)?open\s*\(\s*(['"])(.*?)\1/i)?.[2] ||
              rawHref.match(/^javascript:\s*(?:window\s*\.\s*)?open\s*\(\s*(['"])(.*?)\1/i)?.[2] || "";
            let href = "";
            const candidateHref = openUrl || (!/^(?:javascript:|#|mailto:)/i.test(rawHref) ? rawHref : "");
            if (candidateHref) {
              try { href = new URL(candidateHref, doc.location?.href || location.href).href; }
              catch { href = ""; }
            }
            if (!href || doubleClick) {
              const view = target.ownerDocument?.defaultView;
              // HTMLElement.click() aciona o comportamento padrão de links
              // (incluindo href/target), que uma MouseEvent criada manualmente
              // pode não executar no SIGITM legado. O intervalo curto reproduz
              // o duplo clique que abre a sequência na tabela.
              target.click();
              if (doubleClick) {
                await new Promise(resolve => setTimeout(resolve, 250));
                target.click();
                if (view?.MouseEvent) {
                  target.dispatchEvent(new view.MouseEvent("dblclick", {
                    bubbles: true, cancelable: true, view, detail: 2, button: 0, buttons: 0
                  }));
                }
              }
            }
            return { clicked: true, href };
          }
        }
      }
    }
    return { clicked: false, href: "" };
  }

  function isBooleanYes(value) { return value === true || norm(value) === "sim"; }
  function isBooleanNo(value) { return value === false || norm(value) === "nao"; }

  function displayData(data) {
    return [
      `Chamado: ${data.numeroChamado || "não identificado"}`,
      `Tipo de Abertura: ${data.tipoAbertura || "não identificado"}`,
      `Procedência: ${data.procedencia || "não identificada"}`,
      `Tipo de Incidência: ${data.tipoIncidencia || "não identificada"}`,
      `Cliente: ${data.cliente || "não identificado"}`,
      `Intragov: ${isBooleanYes(data.intragov) ? "Sim" : isBooleanNo(data.intragov) ? "Não" : "não identificado"}`,
      `Serviço Afetado: ${data.servicoAfetado || "não identificado"}`,
      `Data Criação: ${data.dataCriacao || "não identificada"}`,
      `Data de Reparo original: ${data.dataReparoOriginal || "não identificada"}`,
      `Data de Reparo para Encerramento: ${data.dataReparo || "a calcular"}`,
      `Início do SLA: ${data.dataInicioSla || "não identificado"}`,
      `Data Objetivo: ${data.dataObjetivo || "não identificada"}`,
      `Parada de Relógio: ${data.paradaRelogio || "não identificada"}`,
      `Acionamento: ${data.codigoAcionamento ? `${data.codigoAcionamento} (${data.acionamento})` : data.acionamento || "não identificado"}`
    ].join("\n");
  }

  function compareCriticalData(before, after, allowActionChange = false) {
    const keys = ["numeroChamado", "tipoAbertura", "procedencia", "tipoIncidencia", "cliente", "intragov", "servicoAfetado",
      "dataCriacao", "dataObjetivo", "dataReparo"];
    for (const key of keys) if (norm(before[key]) !== norm(after[key])) return `${key} mudou durante o processamento.`;
    if (!allowActionChange && (norm(before.acionamento) !== norm(after.acionamento) || norm(before.codigoAcionamento) !== norm(after.codigoAcionamento))) {
      return "Acionamento mudou durante o processamento.";
    }
    return "";
  }

  async function requestDecision(data) {
    const response = await sendRuntimeMessage({ type: "ANALYZE_CASE", runId: currentRunId, caseData: data });
    return response.decision;
  }

  function askForBaixaCode(data, shouldStop = () => false) {
    return new Promise((resolve, reject) => {
      const style = document.createElement("style");
      style.textContent = `
        #baixa-code-choice-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px;background:#101828b3;backdrop-filter:blur(3px);font:14px 'Segoe UI',system-ui,sans-serif;color:#172033}
        #baixa-code-choice-dialog{width:min(540px,100%);max-height:90vh;overflow:auto;padding:28px;border-radius:24px;background:#fff;box-shadow:0 30px 90px #0006,0 0 0 1px #ffffff22}
        #baixa-code-choice-dialog h2{margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:-.03em}#baixa-code-choice-dialog p{margin:0 0 18px;color:#596579;line-height:1.55}
        #baixa-code-choice-dialog .baixa-case-fields{display:grid;grid-template-columns:minmax(110px,auto) 1fr;gap:8px 14px;margin:0 0 20px;padding:15px;border:1px solid #e3e7f0;border-radius:16px;background:#f8f9fc;font-size:12px}
        #baixa-code-choice-dialog .baixa-case-fields dt{color:#697386;font-size:11px;letter-spacing:.02em}#baixa-code-choice-dialog .baixa-case-fields dd{margin:0;color:#1b2640;font-weight:700;overflow-wrap:anywhere}
        #baixa-code-choice-dialog .baixa-choice-list{display:grid;gap:10px}
        #baixa-code-choice-dialog button{width:100%;padding:14px 16px;border:1px solid #d8deea;border-radius:16px;background:#fff;color:#1b2640;text-align:left;font:inherit;cursor:pointer;transition:border-color .15s,background .15s,transform .15s}
        #baixa-code-choice-dialog button:hover,#baixa-code-choice-dialog button:focus{border-color:#63308b;background:#f8f3fc;outline:3px solid #63308b2e;transform:translateY(-1px)}
        #baixa-code-choice-dialog button strong{display:block;color:#57247d;font-size:16px;font-weight:800;letter-spacing:.02em}#baixa-code-choice-dialog button span{display:block;margin-top:3px;color:#626d80;font-size:12px}
        #baixa-code-choice-dialog .baixa-cancel{margin-top:16px;text-align:center;border-radius:99px;color:#a02d2d;font-weight:700}
      `;
      const overlay = document.createElement("div");
      overlay.id = "baixa-code-choice-overlay";
      overlay.innerHTML = `
        <section id="baixa-code-choice-dialog" role="dialog" aria-modal="true" aria-labelledby="baixa-code-choice-title">
          <h2 id="baixa-code-choice-title">Confirme o código de baixa</h2>
          <p>Confira os dados coletados e selecione o código que deve ser usado. Sua escolha será guardada neste computador para esta combinação.</p>
          <dl class="baixa-case-fields">
            <dt>Tipo de Abertura</dt><dd data-case-field="tipoAbertura"></dd>
            <dt>Procedência</dt><dd data-case-field="procedencia"></dd>
            <dt>Cliente</dt><dd data-case-field="cliente"></dd>
            <dt>Tipo de Incidência</dt><dd data-case-field="tipoIncidencia"></dd>
            <dt>Intragov</dt><dd data-case-field="intragov"></dd>
            <dt>Serviço Afetado</dt><dd data-case-field="servicoAfetado"></dd>
          </dl>
          <div class="baixa-choice-list">
            <button type="button" data-code="57033"><strong>57033</strong><span>Tipo de Incidência DDR</span></button>
            <button type="button" data-code="6Y200"><strong>6Y200</strong><span>Intragov marcado</span></button>
            <button type="button" data-code="2A082"><strong>2A082</strong><span>Repetido + Proativo</span></button>
            <button type="button" data-code="2A011"><strong>2A011</strong><span>Inicial + Preventivo/Reativo/Proativo ou Repetido + Reativo</span></button>
          </div>
          <button type="button" class="baixa-cancel" data-cancel>Cancelar execução</button>
        </section>`;
      const intragovValue = isBooleanYes(data.intragov) ? "Marcada (Sim)"
        : isBooleanNo(data.intragov) ? "Desmarcada (Não)" : "Não identificado";
      const caseFields = {
        tipoAbertura: data.tipoAbertura || "Não identificado",
        procedencia: data.procedencia || "Não identificada",
        cliente: data.cliente || "Não identificado",
        tipoIncidencia: data.tipoIncidencia || "Não identificada",
        intragov: intragovValue,
        servicoAfetado: data.servicoAfetado || "Não identificado"
      };
      for (const [key, value] of Object.entries(caseFields)) {
        overlay.querySelector(`[data-case-field="${key}"]`).textContent = value;
      }
      document.head.append(style);
      document.body.append(overlay);
      const list = overlay.querySelector(".baixa-choice-list");
      const cancelButton = overlay.querySelector("[data-cancel]");
      const stopTimer = setInterval(() => {
        if (shouldStop()) finish(new Error("Automação interrompida pelo usuário."));
      }, 200);
      const onKeyDown = event => {
        if (event.key === "Escape") finish(new Error("Seleção de código cancelada; nenhuma ação adicional será iniciada."));
      };
      let settled = false;
      const cleanup = () => {
        clearInterval(stopTimer);
        document.removeEventListener("keydown", onKeyDown, true);
        overlay.remove();
        style.remove();
      };
      const finish = (error, code = "") => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(code);
      };
      list.addEventListener("click", event => {
        const button = event.target.closest("button[data-code]");
        if (button) finish(null, button.dataset.code);
      });
      cancelButton.addEventListener("click", () => finish(new Error("Seleção de código cancelada; nenhuma ação adicional será iniciada.")));
      document.addEventListener("keydown", onKeyDown, true);
      list.querySelector("button")?.focus();
    });
  }

  function applySelectedCode(decision, data, code, source) {
    const sourceLabel = source === "aprendido" ? "reutilizado da escolha salva"
      : source === "regra de cliente" ? "definido automaticamente pela regra do cliente" : "confirmado pelo usuário";
    const incidence = norm(decision?.normalizedFields?.tipoIncidencia || data?.tipoIncidencia);
    const diagnostico = incidence === "ddr" ? "00000032 Testado OK" : "00000017 Testado OK";
    return {
      ...decision,
      codigoBaixa: code,
      diagnostico,
      allowed: true,
      motivo: `Código ${code} ${sourceLabel}.`,
      codeSelection: { source, codigoBaixa: code },
      validation: {
        ...decision.validation,
        allowed: true,
        status: source === "aprendido" ? "CÓDIGO APRENDIDO" : source === "regra de cliente" ? "REGRA AUTOMÁTICA DO CLIENTE" : "CÓDIGO CONFIRMADO PELO USUÁRIO",
        reason: `Código ${code} ${sourceLabel}.`
      }
    };
  }

  async function chooseCodeForAutomaticRun(data, decision, shouldStop = () => false) {
    const automaticCode = BaixaRules.automaticCodeForClient(data.cliente);
    if (automaticCode) {
      if (!decision.allowed) return { decision, code: automaticCode };
      return { decision: applySelectedCode(decision, data, automaticCode, "regra de cliente"), code: automaticCode };
    }

    // Quando a pirâmide de regras já identificou o código, não interrompa a
    // automação para perguntar novamente. A pergunta fica reservada apenas às
    // combinações que as regras ainda não conhecem.
    if (decision.allowed && BaixaRules.CODES.includes(decision.codigoBaixa)) {
      return { decision, code: "", source: "regras locais" };
    }

    const learnedCode = BaixaRules.CODES.includes(decision.learnedCode?.codigoBaixa)
      ? decision.learnedCode.codigoBaixa : "";
    const selectedCode = learnedCode || await askForBaixaCode(data, shouldStop);
    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");
    const response = await sendRuntimeMessage({
      type: "SAVE_CODE_LEARNING", runId: currentRunId, caseData: data, codigoBaixa: selectedCode,
      source: learnedCode ? "aprendido" : "usuário"
    });
    const source = learnedCode ? "aprendido" : "usuário";
    return { decision: applySelectedCode(decision, data, selectedCode, source), code: selectedCode, learning: response.learning };
  }

  function makeRecord(data, decision, result, error = "") {
    return {
      numeroChamado: data.numeroChamado || "",
      tipoAbertura: data.tipoAbertura || "",
      procedencia: data.procedencia || "",
      tipoIncidencia: data.tipoIncidencia || "",
      cliente: data.cliente || "",
      intragov: data.intragov ?? "",
      servicoAfetado: data.servicoAfetado || "",
      dataObjetivo: data.dataObjetivo || "",
      dataReparo: data.dataReparo || "",
      paradaRelogio: data.paradaRelogio ?? "",
      acionamento: data.codigoAcionamento || (data.acionamentoProcessado6Z036 ? "6Z036 (tratado)" : "Nenhum identificado"),
      codigoBaixa: decision?.codigoBaixa || "",
      origemCodigoBaixa: decision?.codeSelection?.source || "regras locais",
      diagnostico: decision?.diagnostico || "",
      resultado: result,
      iaUtilizada: decision?.ai?.available ? decision.ai.provider : "Motor determinístico (fallback)",
      confianca: decision?.ai?.confidence ?? "",
      motivo: decision?.allowed ? decision.motivo : decision?.validation?.reason || decision?.motivo || "",
      erro: error
    };
  }

  async function runAnalysis(runId, batch = null) {
    if (processing) {
      if (runId && runId !== currentRunId) {
        stopRequested = true;
        queuedRunId = runId;
        queuedBatch = batch;
        notify("Substituindo a execução anterior pela nova solicitação…");
      }
      return;
    }
    processing = true;
    currentRunId = runId;
    stopRequested = false;
    let data = {};
    let decision = null;
    let mainClosureSubmitted = false;
    notify("Iniciando leitura rápida das abas do chamado…");
    try {
      data = await BaixaNavigation.readCase(stopCheck, tab => notify(`Leitura inicial: aguardando a aba ${tab}…`));
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      notify("Campos lidos. Enviando apenas os campos de classificação à IA e às regras locais…");
      decision = await requestDecision(data);
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      let selectedCode = "";
      let selectionOrigin = "";
      if (decision.mode === "automatic") {
        const selection = await chooseCodeForAutomaticRun(data, decision, stopCheck);
        decision = selection.decision;
        selectedCode = selection.code;
        selectionOrigin = decision.codeSelection?.source || "regra de cliente";
      }
      const allowed = Boolean(decision.allowed);
      const validationText = decision.validation.reason || decision.motivo || "Classificação aprovada pelas regras locais.";
      decision = {
        ...decision,
        allowed,
        validation: {
          ...decision.validation,
          allowed,
          status: allowed ? decision.validation.status : "BLOQUEADO",
          reason: validationText
        }
      };
      const summary = [
        displayData(data),
        "",
        `Código de baixa: ${decision.codigoBaixa || "não determinado"}`,
        `Diagnóstico: ${decision.diagnostico || "não determinado"}`,
        `Motivo: ${decision.motivo || decision.validation.reason}`,
        `Confiança da IA: ${decision.ai?.confidence == null ? "indisponível (fallback)" : `${Math.round(decision.ai.confidence * 100)}%`}`,
        `IA utilizada: ${decision.ai?.available ? decision.ai.provider : "Não — motor determinístico"}`,
        `Validação: ${allowed ? decision.validation.status : "BLOQUEADO — " + validationText}`
      ].join("\n");
      notify(summary, allowed ? "success" : "error");

      if (!allowed) {
        await sendFinal(makeRecord(data, decision, decision.validation.status === "DIVERGÊNCIA IA × REGRAS" ? "DIVERGÊNCIA IA × REGRAS" : "BAIXA NÃO REALIZADA", validationText));
        await sendBatchTicketResult(batch, { success: false, uncertain: false, reason: validationText });
        return;
      }
      if (decision.mode !== "automatic") {
        await sendFinal(makeRecord(data, decision, "ANÁLISE CONCLUÍDA"));
        notify(`${summary}\n\nModo análise: a leitura terminou; nenhuma baixa foi executada. Para prosseguir com as etapas automáticas, selecione “Modo automático” no popup.`, "success");
        return;
      }

      if (stopCheck()) throw new Error("Automação interrompida.");
      if (data.codigoAcionamento === "6Z036" && data.acionamento === "Sim") {
        notify("Acionamento ativo 6Z036: tratando antes da baixa principal…");
        await BaixaHandler.closeActiveAction(data, stopCheck);
        if (stopCheck()) throw new Error("Automação interrompida após tratar o acionamento.");
        const afterAction = await BaixaNavigation.readCase(stopCheck, tab => notify(`Releitura após o acionamento: aguardando a aba ${tab}…`));
        const changed = compareCriticalData(data, afterAction, true);
        if (changed) throw new Error(`Revalidação interrompida: ${changed}`);
        if (afterAction.codigoAcionamento === "6Z036" && afterAction.acionamento === "Sim") throw new Error("O acionamento 6Z036 continua ativo após a tentativa de baixa.");
        if (!isBooleanNo(afterAction.acionamento)) throw new Error("Não foi possível confirmar que o acionamento ficou inativo após o tratamento.");
        data = { ...afterAction, acionamentoProcessado6Z036: true };
        decision = await requestDecision(data);
        decision = selectedCode
          ? applySelectedCode(decision, data, selectedCode, selectionOrigin)
          : decision;
        if (!decision.allowed) throw new Error(decision.validation.reason || "A decisão não passou pela validação após tratar o acionamento.");
      }

      const dateValidation = BaixaDateHandler.validateDates(data);
      if (!dateValidation.valid) throw new Error(dateValidation.reason);
      data.dataReparo = dateValidation.repairValue;
      notify(`Data de Reparo para Encerramento calculada: ${data.dataReparo} (Data Criação + 1 hora${data.dataReparoOriginal ? "; sem copiar a Data de Reparo original" : ""}). Validação de Data Objetivo, pausa de relógio e SLA de 4 horas aprovada.`);

      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      notify("Executando sequência solicitada: Bloquear → fechar popup informativo → Baixar…");
      await BaixaHandler.beginMainClosure(stopCheck);
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      notify("Bloquear e clique no botão Baixar concluídos. Abrindo Definição para preencher e selecionar o Diagnóstico pela lupa…");
      const diagnosisSkipped = await BaixaFormHandler.fillDiagnosis(decision, stopCheck);
      if (diagnosisSkipped.length) notify(`Diagnóstico não editável; mantendo valor atual: ${diagnosisSkipped.join(", ")}.`);
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      notify("Diagnóstico selecionado. Seguindo para Encerramento sem repetir a ação Baixar.");
      const skippedFields = await BaixaFormHandler.fillClosure(decision, isBooleanYes(data.intragov), data.dataReparo, stopCheck, true);
      if (skippedFields.length) notify(`Tentativa continuará; campos não editáveis ou sem dado foram deixados como estão: ${skippedFields.join(", ")}.`);
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");

      notify("Encerramento preenchido. Verificando a aba Certificação antes de clicar em Gravar Baixa…");
      const certificationPrecheck = await BaixaFormHandler.prepareCertificationForSave(stopCheck);
      notify("Certificação preenchida (Circuito e Medições = Não; Roteador, Gerência de Modem, Modem Cliente, TX e DG = Não se aplica). Voltando para Encerramento…");
      if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
      notify("Certificação preenchida e confirmada. Agora sim, acionando Gravar Baixa…");
      let saveResult = await BaixaHandler.saveMainClosure(stopCheck);

      // Se o SIGITM rejeitar a gravação por campos obrigatórios da Certificação,
      // entrar na aba, preencher automaticamente todos os "Selecione um status"
      // com "Não se aplica" quando existir e, caso contrário, com "Não", e gravar
      // novamente.
      if (saveResult?.validationError) {
        notify("Gravar Baixa encontrou campos obrigatórios na Certificação. Fechando o aviso pelo X (ou aproveitando o fechamento manual) e abrindo a aba Certificação…");
        const validationPopupClosed = await BaixaHandler.closeValidationErrorPopup(stopCheck);
        if (validationPopupClosed) {
          notify("Aviso de validação fechado. Abrindo Certificação para corrigir somente os status pendentes…");
        } else if (saveResult.popupCloseObserved) {
          notify("O aviso de validação já foi fechado. Continuando automaticamente para a aba Certificação…");
        } else {
          notify("O SIGITM não expôs um popup identificável. A extensão seguirá diretamente para Certificação…");
        }
        const certification = await BaixaFormHandler.fixCertificationValidation(stopCheck);
        notify(`Certificação corrigida: ${certification.changed} campo(s). Tentando Gravar Baixa novamente…`);
        saveResult = await BaixaHandler.saveMainClosure(stopCheck);
        if (saveResult?.validationError) {
          throw new Error("O SIGITM ainda retornou 'Validation Error: Value is required.' após corrigir a aba Certificação.");
        }
      }

      mainClosureSubmitted = true;
      notify(batch ? "Gravar Baixa aceito. Aguardando a confirmação final “Tíquete Liberado” antes de fechar a guia…"
        : "Gravar Baixa aceito. Aguardando a confirmação final do SIGITM…");
      let resultLabel = "GRAVAR BAIXA ACIONADO";
      if (batch) {
        if (!await BaixaHandler.waitForTicketReleased(30000, stopCheck)) {
          throw new Error("O SIGITM não apresentou a confirmação “Ticket liberado” após Gravar Baixa.");
        }
        resultLabel = "TICKET LIBERADO";
      } else if (await BaixaHandler.waitForTicketReleased(30000, stopCheck)) {
        resultLabel = "TICKET LIBERADO";
        notify("Ticket liberado. Voltando à Validação Massiva, atualizando a tabela e abrindo o próximo BD…");
        await sendRuntimeMessage({ type: "CONTINUE_MASSIVE_LIST" });
      }
      const resultRecord = makeRecord(data, decision, resultLabel);
      await sendFinal(resultRecord);
      notify(batch ? "Ticket liberado. A guia será fechada e a lista seguirá para o próximo chamado."
        : "Gravar Baixa acionado automaticamente após o preenchimento e validação dos campos.", "success");
      await sendBatchTicketResult(batch, { success: true, uncertain: false });
    } catch (error) {
      const superseded = /substituída por uma execução mais recente/i.test(error.message);
      const stopped = stopCheck() || superseded || /interrompida pelo usuário/i.test(error.message);
      const status = stopped ? "PROCESSAMENTO INTERROMPIDO" : "BAIXA NÃO REALIZADA";
      const replacementPending = stopped && queuedRunId && queuedRunId !== currentRunId;
      if (!replacementPending) queuedRunId = "";
      if (replacementPending) {
        notify("Execução anterior cancelada; iniciando a solicitação mais recente…");
      } else {
        await sendFinal(makeRecord(data, decision, status, error.message));
        notify(`${status}\n${error.message}\nNenhuma ação adicional será iniciada.`, "error");
        // Qualquer falha durante a preparação/preenchimento precisa manter o
        // ticket aberto para correção. Nunca avance ou feche a guia sem a baixa
        // ter concluído e o SIGITM ter confirmado o resultado.
        await sendBatchTicketResult(batch, { success: false, uncertain: Boolean(batch), cancelled: stopped, reason: error.message });
      }
    } finally {
      processing = false;
      const finishedRunId = currentRunId;
      chrome.runtime.sendMessage({ type: "RUN_FINISHED", runId: finishedRunId }, () => void chrome.runtime.lastError);
      currentRunId = "";
      if (queuedRunId) {
        const nextRunId = queuedRunId;
        const nextBatch = queuedBatch;
        queuedRunId = "";
        queuedBatch = null;
        void runAnalysis(nextRunId, nextBatch);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_BAIXADOR_CONTENT_STATUS") {
      sendResponse({ ok: true, protocol: CONTENT_PROTOCOL });
      return false;
    }
    if (message?.type === "START_ANALYSIS_V8" && message.protocol === CONTENT_PROTOCOL && message.runId) {
      void runAnalysis(message.runId, message.batch || null);
      sendResponse({ ok: true, started: true, runId: message.runId });
      return false;
    }
    if (message?.type === "READ_BATCH_LIST_STATE_V8" && message.protocol === CONTENT_PROTOCOL) {
      void BaixaNavigation.waitForLoadingToFinish(stopCheck).then(() => sendResponse({ ok: true, state: BaixaBatch.readListState() }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "CLICK_BATCH_TICKET_V8" && message.protocol === CONTENT_PROTOCOL) {
      void BaixaNavigation.waitForLoadingToFinish(stopCheck).then(() => {
        return clickBatchSequence(message.sequence, message.doubleClick === true).then(result => {
          sendResponse({ ok: result.clicked, href: result.href, error: result.clicked ? "" : `Número da sequência ${message.sequence} não encontrado na coluna Seq.` });
        });
      }).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "REFRESH_BATCH_LIST_V8" && message.protocol === CONTENT_PROTOCOL) {
      void BaixaNavigation.waitForLoadingToFinish(stopCheck).then(async () => {
        const before = JSON.stringify(BaixaBatch.readListState());
        BaixaHandler.findUniqueButton(["Atualizar"]).click();
        const startedAt = Date.now();
        let sawLoader = false;
        let stableSince = startedAt;
        let lastState = before;
        while (Date.now() - startedAt < 30000) {
          if (stopCheck()) throw new Error("Automação interrompida pelo usuário.");
          const loading = BaixaNavigation.loadingIndicators().length > 0;
          const currentState = JSON.stringify(BaixaBatch.readListState());
          if (loading) {
            sawLoader = true;
            stableSince = Date.now();
          } else if (currentState !== lastState) {
            lastState = currentState;
            stableSince = Date.now();
          } else if (Date.now() - startedAt >= 1200 && Date.now() - stableSince >= (sawLoader ? 400 : 1800)) {
            return { state: BaixaBatch.readListState(), sawLoader };
          }
          await BaixaHelpers.sleep(100);
        }
        throw new Error("A lista SIGITM não terminou de atualizar em 30 segundos.");
      }).then(result => sendResponse({ ok: true, ...result }))
        .catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "BATCH_STATUS_V8" && message.protocol === CONTENT_PROTOCOL) {
      notify(message.message || "Processamento de lista em andamento…", message.status === "error" ? "error" : "info");
      if (message.status === "success" && /processamento encerrado|zero registros/i.test(message.message || "")) {
        BaixaNotifications.celebrate("Todos os BDs foram concluídos.");
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "STOP_AUTOMATION") {
      if (message.runId && message.runId !== currentRunId) {
        if (message.runId === queuedRunId) {
          queuedRunId = "";
          stopRequested = true;
        }
        return;
      }
      stopRequested = true;
      notify("PARAR AUTOMAÇÃO — processamento interrompido. O resultado atual foi mantido.", "error");
      return false;
    }
    return false;
  });
})();
