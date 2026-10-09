"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const base = path.join(__dirname, "..");
const helpers = require(path.join(base, "utils/helpers.js"));
global.BaixaHelpers = helpers;
const rules = require(path.join(base, "rules/baixa-rules.js"));
global.BaixaRules = rules;
const validation = require(path.join(base, "rules/validation.js"));
const navigation = require(path.join(base, "automation/navigation.js"));
global.BaixaNavigation = navigation;
const batchHandler = require(path.join(base, "automation/batch-handler.js"));
global.BaixaBatch = batchHandler;
const baixaHandler = require(path.join(base, "automation/baixa-handler.js"));
const formHandler = require(path.join(base, "automation/form-handler.js"));
const runGuard = require(path.join(base, "background/run-guard.js"));
const aiSchema = require(path.join(base, "ai/ai-schema.js"));
global.BaixaAISchema = aiSchema;
const aiProvider = require(path.join(base, "ai/ai-provider.js"));
global.BaixaAIProvider = aiProvider;
const aiService = require(path.join(base, "ai/ai-service.js"));
const dateHandler = require(path.join(base, "automation/date-handler.js"));
global.BaixaDateHandler = dateHandler;
const queue = require(path.join(base, "automation/queue.js"));
const storage = require(path.join(base, "storage/storage.js"));

function fields(overrides = {}) {
  return {
    numeroChamado: "123456",
    tipoAbertura: "INICIAL",
    procedencia: "REATIVO",
    tipoIncidencia: "DADOS",
    cliente: "CEDRO",
    intragov: "Não",
    servicoAfetado: "Internet",
    dataCriacao: "02/10/2026 08:00",
    dataInicioSla: "02/10/2026 08:00",
    dataReparo: "02/10/2026 10:00",
    dataObjetivo: "02/10/2026 12:00",
    paradaRelogio: "Não",
    dataParadaRelogio: "",
    acionamento: "Não",
    codigoAcionamento: "",
    ...overrides
  };
}

async function main() {
  const runId = "run-current-123";
  const controller = new AbortController();
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: null,
    memoryRun: { runId, controller }
  }).repairStorage, true, "Um run ainda ativo em memória deve recuperar um lock ausente no storage");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: { tabId: 9, runId, stopped: false },
    memoryRun: null
  }).allowed, true, "O storage deve reconhecer a execução após reinício do service worker");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: { tabId: 9, runId, stopped: true },
    memoryRun: null
  }).allowed, false, "Execução parada não pode ser recuperada automaticamente");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: null,
    memoryRun: { runId: "different-run", controller: new AbortController() }
  }).allowed, false, "Run ID estranho não pode ser aceito");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: { tabId: 8, runId: "other-run", stopped: false },
    memoryRun: { runId, controller }
  }).allowed, false, "Execução ativa em outra guia deve continuar bloqueando");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: { tabId: 9, runId: "newer-run", stopped: false },
    memoryRun: { runId, controller }
  }).source, "memory", "O run atual em memória deve reparar um lock antigo da mesma guia");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: { tabId: 9, runId: "newer-run", stopped: false },
    memoryRun: { runId: "older-run", controller: new AbortController() }
  }).reason, "Esta solicitação foi substituída por uma execução mais recente.", "Um run antigo não deve suplantar o run persistido mais recente");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: null,
    memoryRun: null,
    stopRequested: false
  }).source, "recovered-request", "Um lock perdido pode ser recuperado quando não existe parada explícita");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: null,
    memoryRun: null,
    stopRequested: true
  }).allowed, false, "Um pedido explícito de parada não pode ser recuperado");
  assert.equal(runGuard.authorizeRun({
    tabId: 9, runId,
    persistentRun: null,
    memoryRun: null,
    stopRequested: false,
    hasOtherActiveRun: true
  }).allowed, false, "Uma solicitação não pode recuperar execução enquanto outra guia estiver ativa");

  let clickedTab = false;
  const legacyTab = {
    tagName: "TD",
    innerText: "Definição",
    textContent: "Definição",
    disabled: false,
    offsetParent: {},
    getClientRects: () => [{ width: 70, height: 28 }],
    getAttribute: () => null,
    matches: selector => selector.includes("td"),
    closest() { return this; },
    contains: () => false,
    click() { clickedTab = true; }
  };
  global.document = {
    querySelectorAll(selector) {
      if (selector === "iframe, frame") return [];
      if (selector.startsWith("a, button")) return [];
      if (selector === "td, th, li, span, div") return [legacyTab];
      return [];
    }
  };
  assert.equal(await navigation.clickTab("Definição"), true, "Deve clicar em abas SIGITM desenhadas como células antigas de tabela");
  assert.equal(clickedTab, true);
  assert.deepEqual(navigation.resolveActionState(false, ""), { acionamento: "Não", codigoAcionamento: "" }, "Sem 6Z036, o fluxo normal não deve ser bloqueado por texto ausente de acionamento");
  assert.deepEqual(navigation.resolveActionState(true, "acionamento ativo"), { acionamento: "Sim", codigoAcionamento: "6Z036" });
  assert.deepEqual(navigation.resolveActionState(true, "acionamento encerrado"), { acionamento: "Não", codigoAcionamento: "" });
  assert.deepEqual(navigation.resolveActionState(true, "status não identificado"), { acionamento: "", codigoAcionamento: "" }, "Se 6Z036 existe mas estado não é legível, o fluxo continua bloqueado por segurança");
  assert.equal(batchHandler.listName("http://sigitm.redecorp.br/SIGITMWeb/pages/consulta/listConsulta.jsf?idConsulta=138550"), "Ativos e Parados");
  assert.equal(batchHandler.listName("http://sigitm.redecorp.br/SIGITMWeb/pages/consulta/listConsulta.jsf?idConsulta=95803"), "Validação Massiva");
  assert.equal(batchHandler.listName("http://sigitm.redecorp.br/SIGITMWeb/pages/consulta/listConsulta.jsf?idConsulta=unknown"), "");
  const emptyListDoc = { body: { innerText: "Ativos e Parados (Registros: 0 de 0)" }, querySelectorAll: () => [] };
  assert.deepEqual(batchHandler.readListState([emptyListDoc]), { tickets: [], empty: true, recordCount: { shown: 0, total: 0 } }, "Deve parar ao identificar consulta com zero registros");
  const mockText = text => ({ innerText: text, textContent: text, getClientRects: () => [{}], offsetParent: {} });
  const sequenceLink = mockText("6969062");
  const sequenceCell = { ...mockText("6969062"), querySelector: () => sequenceLink };
  const headerRow = { querySelectorAll: () => [mockText("Seq↕"), mockText("Status")] };
  const ticketRow = { querySelectorAll: () => [sequenceCell, mockText("Ativo")] };
  const table = { querySelectorAll: selector => selector === "tr" ? [headerRow, ticketRow] : [] };
  const listDoc = { body: { innerText: "Ativos e Parados (Registros: 1 de 1)" }, querySelectorAll: selector => selector === "table" ? [table] : [] };
  assert.deepEqual(batchHandler.readListState([listDoc]), { tickets: ["6969062"], empty: false, recordCount: { shown: 1, total: 1 } }, "Deve obter o número da coluna Seq mesmo se o alvo de clique não puder ser lido");
  const noAnchorCell = { ...mockText("6969157") };
  const unlinkedTicketRow = { querySelectorAll: () => [noAnchorCell, mockText("Ativo")] };
  const twoTicketsTable = { querySelectorAll: selector => selector === "tr" ? [headerRow, ticketRow, unlinkedTicketRow] : [] };
  const twoTicketsDoc = { body: { innerText: "Ativos e Parados (Registros: 2 de 2)" }, querySelectorAll: selector => selector === "table" ? [twoTicketsTable] : [] };
  assert.deepEqual(batchHandler.readListState([twoTicketsDoc]), { tickets: ["6969062", "6969157"], empty: false, recordCount: { shown: 2, total: 2 } }, "Deve ler todos os tickets da coluna Seq mesmo quando uma célula não contém uma âncora reconhecida");
  const blockControl = {
    tagName: "INPUT", type: "button", value: "BLOQUEAR", disabled: false,
    offsetParent: {}, getClientRects: () => [{ width: 90, height: 28 }],
    getAttribute: () => null, querySelector: () => null, click() {}
  };
  global.document.querySelectorAll = selector => selector === "iframe, frame" ? [] : [blockControl];
  assert.equal(baixaHandler.findUniqueButton(["Bloquear"]), blockControl, "Deve reconhecer botões antigos do SIGITM pelo value independente de maiúsculas");
  global.document.querySelectorAll = selector => selector === "iframe, frame" ? [] : [];
  assert.throws(() => baixaHandler.findUniqueButton(["Baixar"]), /Botão “Baixar” não encontrado/);
  const customPopupX = {
    disabled: false, onclick: "fecharMensagem()", className: "icone", ownerDocument: { defaultView: {} },
    offsetParent: {}, getClientRects: () => [{ width: 18, height: 18 }],
    getBoundingClientRect: () => ({ left: 724, right: 742, top: 158, bottom: 176 }),
    getAttribute: () => "", matches: () => false, querySelector: () => null,
    querySelectorAll: () => [], closest: () => null, click() {}
  };
  const popupPanel = {
    getBoundingClientRect: () => ({ left: 179, right: 743, top: 151, bottom: 529 }),
    querySelectorAll: () => [customPopupX]
  };
  assert.deepEqual(baixaHandler.closeImageCandidates(popupPanel), [customPopupX], "Deve localizar o X customizado pela posição superior direita mesmo sem texto alt/aria");
  const footerClose = {
    disabled: false, onclick: "fecharRodape()", className: "botao-fechar", ownerDocument: { defaultView: {} },
    offsetParent: {}, getClientRects: () => [{ width: 22, height: 22 }],
    getBoundingClientRect: () => ({ left: 300, right: 322, top: 500, bottom: 522 }),
    getAttribute: () => "", matches: () => false, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, click() {}
  };
  const popupWithTwoClosers = {
    getBoundingClientRect: () => ({ left: 179, right: 743, top: 151, bottom: 529 }),
    querySelectorAll: () => [footerClose, customPopupX]
  };
  assert.equal(baixaHandler.selectBestPopupCloseControl(popupWithTwoClosers), customPopupX, "Quando existirem vários controles de fechar, o X no canto superior direito deve ser escolhido automaticamente");
  assert.ok(baixaHandler.findCloseControlNearPopup, "O detector deve ter fallback global para um X renderizado fora do contêiner lógico do popup");
  let customCloseCalled = false;
  const javascriptCloseLink = {
    getAttribute: name => name === "href" ? "javascript:closeMensagem()" : "",
    ownerDocument: { defaultView: { closeMensagem() { customCloseCalled = true; } } }
  };
  assert.equal(baixaHandler.invokeSafeJavaScriptClose(javascriptCloseLink), true, "Deve contornar href javascript: CSP por chamada segura à função de fechamento disponível");
  assert.equal(customCloseCalled, true);
  assert.equal(baixaHandler.invokeSafeJavaScriptClose({ getAttribute: name => name === "href" ? "javascript:alert(document.cookie)" : "", ownerDocument: { defaultView: {} } }), false, "Não deve avaliar expressões javascript arbitrárias");
  let richFacesPanelId = "";
  const richFacesCloseLink = {
    getAttribute: name => name === "onclick" ? "RichFaces.hideModalPanel('mensagemValidacao')" : "",
    ownerDocument: { defaultView: { RichFaces: { hideModalPanel(id) { richFacesPanelId = id; } } } }
  };
  assert.equal(baixaHandler.invokeRichFacesModalClose(richFacesCloseLink, { id: "mensagemValidacao" }), true, "Deve fechar o modal RichFaces pelo manipulador seguro da própria página");
  assert.equal(richFacesPanelId, "mensagemValidacao");
  assert.throws(() => formHandler.setValue({ name: "repairDate", disabled: true, readOnly: false }, "02/10/2026 10:00"), /repairDate indisponível: está desabilitado/);
  class MockDateInput {
    constructor() {
      this.tagName = "INPUT";
      this.type = "text";
      this.name = "repairDate";
      this.id = "repairDate";
      this.disabled = true;
      this.readOnly = true;
      this._value = "";
      this.events = [];
      this.flagsAtEvents = [];
      this.ownerDocument = { defaultView: { HTMLInputElement: MockDateInput, Event: class { constructor(type) { this.type = type; } } } };
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    getClientRects() { return [{ width: 140, height: 22 }]; }
    dispatchEvent(event) { this.events.push(event.type); this.flagsAtEvents.push([this.disabled, this.readOnly]); return true; }
  }
  const lockedDateField = new MockDateInput();
  formHandler.setValue(lockedDateField, "02/10/2026 10:00", { allowLocked: true });
  assert.equal(lockedDateField.value, "02/10/2026 10:00", "Data de Reparo readonly/desabilitada deve receber valor via setter quando autorizada pelo fluxo específico");
  assert.deepEqual(lockedDateField.flagsAtEvents, [[false, false], [false, false], [false, false]], "Eventos de alteração devem ser despachados enquanto o campo está temporariamente editável");
  assert.equal(lockedDateField.disabled, true, "O estado original disabled deve ser restaurado depois do preenchimento");
  assert.equal(lockedDateField.readOnly, true, "O estado original readonly deve ser restaurado depois do preenchimento");
  const originalPhoneControls = navigation.controlsFor;
  const originalPhoneDocuments = navigation.documents;
  const phoneYellow = (name, top, left) => ({
    name, disabled: false, readOnly: false, type: "text", style: { backgroundColor: "rgb(248, 255, 200)" },
    getBoundingClientRect: () => ({ top, left })
  });
  const phoneControls = [phoneYellow("phone-number", 30, 185), phoneYellow("phone-extra", 52, 145), phoneYellow("phone-ddd", 30, 145),
    { name: "historical-phone", disabled: false, readOnly: false, type: "text", style: { backgroundColor: "rgb(255, 255, 255)" } }];
  navigation.controlsFor = () => phoneControls;
  navigation.documents = () => [];
  assert.deepEqual(formHandler.closurePhoneControls(), [phoneControls[2], phoneControls[0], phoneControls[1]],
    "Deve selecionar e ordenar os três Telefones amarelos, ignorando os controles históricos brancos");
  assert.throws(() => formHandler.phoneValuesForLayout(true, 2), /caixas de DDD e número/, "Intragov exige DDD, número e segundo Telefone");
  assert.deepEqual(formHandler.phoneValuesForLayout(true, 3), ["00", "000000000", "xx"], "Layout Intragov aplica DDD/número ao primeiro Telefone e xx ao segundo");
  assert.deepEqual(formHandler.phoneValuesForLayout(false, 2), ["xx", "xx"], "Layout comum mantém dois Telefones com xx");
  navigation.controlsFor = originalPhoneControls;
  navigation.documents = originalPhoneDocuments;
  const originalControlsFor = navigation.controlsFor;
  const serviceOptions = [{ value: "service-sai", textContent: "Acesso à Internet" }];
  let selectedServiceValue = "";
  const serviceSelect = {
    tagName: "SELECT", type: "select-one", name: "servicoAfetado", disabled: false, readOnly: false,
    options: serviceOptions,
    get value() { return selectedServiceValue; },
    set value(value) { selectedServiceValue = value; },
    get selectedOptions() { return serviceOptions.filter(option => option.value === selectedServiceValue); },
    getClientRects: () => [{ width: 160, height: 24 }],
    ownerDocument: { defaultView: { Event: class { constructor(type) { this.type = type; } } } },
    dispatchEvent() { return true; }
  };
  formHandler.setValue(serviceSelect, "SAI - Serviço de Acesso à Internet");
  assert.equal(serviceSelect.value, "service-sai", "O Encerramento deve aceitar rótulos equivalentes de SAI sem repetir o prefixo ou a palavra Serviço");
  const scmOption = { value: "03913923", textContent: "03913923 - SCM" };
  let selectedScmValue = "";
  const scmSelect = {
    ...serviceSelect,
    options: [scmOption],
    get value() { return selectedScmValue; },
    set value(value) { selectedScmValue = value; },
    get selectedOptions() { return [scmOption].filter(option => option.value === selectedScmValue); }
  };
  formHandler.setValue(scmSelect, "SCM - Serviço de Comunicação Multimídia");
  assert.equal(scmSelect.value, "03913923", "O Encerramento deve reconhecer opções codificadas por serviço, como SCM com número antes da sigla");
  const readonlyDiagnosis = { name: "diagnosis", disabled: false, readOnly: true };
  navigation.controlsFor = (_aliases, editableOnly = false) => editableOnly ? [] : [readonlyDiagnosis];
  const skippedReadonlyFields = [];
  formHandler.fillBestEffort(["Diagnóstico"], "00000017 Testado OK", skippedReadonlyFields);
  assert.deepEqual(skippedReadonlyFields, ["Diagnóstico"], "Campo readonly é ignorado para deixar o SIGITM decidir a tentativa");
  const skippedMissingDate = [];
  assert.throws(() => formHandler.fillBestEffort(["Data de Reparo"], "", skippedMissingDate), /Data de Reparo não pôde ser calculada/);
  const originalDocuments = navigation.documents;
  const baixaCodeField = {
    disabled: false, readOnly: true,
    getBoundingClientRect: () => ({ left: 100, right: 260, top: 20, bottom: 44 })
  };
  let lupaClicked = false;
  const lupa = {
    tagName: "IMG", alt: "lupa", disabled: false, ownerDocument: { defaultView: {} },
    getClientRects: () => [{ width: 16, height: 16 }], offsetParent: {},
    getBoundingClientRect: () => ({ left: 264, right: 280, top: 24, bottom: 40 }),
    getAttribute: name => name === "alt" ? "lupa" : "", matches: selector => selector.includes("img"),
    closest: () => ({ click() { lupaClicked = true; } }),
    querySelector: () => null, click() { lupaClicked = true; }
  };
  global.document = { querySelectorAll: selector => selector === "iframe, frame" ? [] : [lupa] };
  navigation.controlsFor = () => [baixaCodeField];
  navigation.documents = () => [{ querySelectorAll: selector => selector === "iframe, frame" ? [] : [lupa] }];
  assert.equal(await formHandler.clickBaixaCodeLookup("2A011"), true, "A lupa sem rótulo deve ser achada por proximidade ao campo");
  assert.equal(lupaClicked, true);
  navigation.documents = originalDocuments;
  navigation.controlsFor = originalControlsFor;
  const originalDocumentsForCode = navigation.documents;
  const originalControlsForCode = navigation.controlsFor;
  const codeControl = {
    id: "", name: "", title: "", disabled: false, readOnly: true,
    tagName: "INPUT", type: "text", value: "",
    getAttribute: () => "", labels: [],
    getClientRects: () => [{ width: 180, height: 24 }], offsetParent: {},
    closest: () => codeRow
  };
  const codeRow = {
    textContent: "Código Completo da Baixa",
    getClientRects: () => [{ width: 300, height: 30 }], offsetParent: {},
    querySelectorAll: () => [codeControl]
  };
  navigation.controlsFor = () => [];
  navigation.documents = () => [{ querySelectorAll: selector => selector.includes("input") ? [codeControl] : [] }];
  assert.equal(formHandler.findBaixaCodeField(), codeControl, "Deve localizar Código Completo da Baixa pela linha mesmo sem metadados de campo");
  navigation.documents = originalDocumentsForCode;
  navigation.controlsFor = originalControlsForCode;
  delete global.document;

  assert.equal(rules.decide(fields({ procedencia: "PREVENTIVO" })).codigoBaixa, "2A011", "Inicial + Preventivo");
  assert.equal(rules.decide(fields({ procedencia: "REATIVO" })).codigoBaixa, "2A011", "Inicial + Reativo");
  assert.equal(rules.decide(fields({ procedencia: "PROATIVO" })).codigoBaixa, "2A011", "Inicial + Proativo");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "REATIVO" })).codigoBaixa, "2A011", "Repetida + Reativo");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 30 DIAS", procedencia: "PROATIVO", cliente: "CEDRO" })).codigoBaixa, "2A082", "Repetida + Proativo");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", cliente: "CEDRO" })).codigoBaixa, "2A082");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 30 DIAS", procedencia: "PROATIVO", cliente: "CEDRO" })).codigoBaixa, "2A082");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "REATIVO", cliente: "FED - FUNDO PARA O DESENVOLVIMENTO DA EDUCAÇÃO", intragov: "", servicoAfetado: "" })).codigoBaixa, "2A011", "Repetida + Reativo usa 2A011 para FED");
  assert.equal(rules.decide(fields({ tipoAbertura: "INICIAL", procedencia: "REATIVO", cliente: "SEDUC - SECRETARIA DE EDUCAÇÃO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).codigoBaixa, "2A011", "SEDUC determina 2A011 acima de Intragov + SAI");
  assert.equal(rules.decide(fields({ tipoAbertura: "INICIAL", procedencia: "REATIVO", cliente: "CEDRO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).codigoBaixa, "6Y200", "Intragov marcado usa 6Y200 para os demais clientes");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", cliente: "CEDRO", intragov: "Sim", servicoAfetado: "Serviço corporativo" })).codigoBaixa, "6Y200", "Intragov marcado não depende do Serviço Afetado");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDO", procedencia: "PROATIVO", cliente: "CEDRO" })).codigoBaixa, "2A082", "A forma genérica Repetido + Proativo usa 2A082");
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 30 DIAS", procedencia: "PREVENTIVO", cliente: "CEDRO" })).allowed, false);
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PREVENTIVO", cliente: "CEDRO" })).allowed, false);
  assert.equal(rules.decide(fields({ tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", tipoIncidencia: "DDR", cliente: "CEDRO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).codigoBaixa, "57033", "DDR tem prioridade sobre SAI e repetida para clientes que não são SEDUC");
  assert.equal(rules.decide({ tipoIncidencia: "DDR" }).codigoBaixa, "57033", "DDR não depende dos outros campos de classificação");
  assert.equal(rules.decide(fields({ cliente: "SEDUC - SECRETARIA DE EDUCAÇÃO", tipoIncidencia: "DDR", tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).codigoBaixa, "2A011", "SEDUC determina 2A011 mesmo quando outros campos indicariam códigos prioritários");
  assert.equal(rules.decide(fields({ cliente: "SEDUC - SECRETARIA DE EDUCAÇÃO", tipoIncidencia: "DDR", tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).diagnostico, "00000032 Testado OK", "Mesmo com prioridade SEDUC, DDR deve usar diagnóstico 32");
  assert.equal(rules.decide({ cliente: "SEDUC" }).codigoBaixa, "2A011", "SEDUC determina 2A011 mesmo com os demais campos ausentes");
  assert.equal(rules.automaticCodeForClient("FED - FUNDO PARA O DESENVOLVIMENTO DA EDUCAÇÃO"), "2A011", "FED recebe código automático sem perguntar");
  assert.equal(rules.automaticCodeForClient("Fundação para o Desenvolvimento da Educação"), "2A011", "Fundação para o Desenvolvimento da Educação recebe 2A011 automático");
  assert.equal(rules.decide(fields({ cliente: "Fundação para o Desenvolvimento da Educação", intragov: "Sim", tipoAbertura: "REPETIDA 7 DIAS", procedencia: "PROATIVO", tipoIncidencia: "DADOS", servicoAfetado: "SCM - Serviço de Comunicação Multimídia" })).codigoBaixa, "2A011", "Fundação para o Desenvolvimento da Educação prevalece sobre Intragov");
  assert.equal(rules.automaticCodeForClient("SAO PAULO SECRETARIA DA EDUCACAO"), "2A011", "SEDUC de São Paulo com SECRETARIA DA EDUCACAO deve ser reconhecida");
  assert.equal(rules.decide(fields({
    tipoAbertura: "REPETIDA 30 DIAS",
    procedencia: "PROATIVO",
    tipoIncidencia: "DADOS",
    cliente: "SAO PAULO SECRETARIA DA EDUCACAO",
    intragov: "Sim",
    servicoAfetado: "SCM - Serviço de Comunicação Multimídia"
  })).codigoBaixa, "2A011", "Caso real SEDUC São Paulo não deve cair em 6Y200 por Intragov");
  assert.equal(rules.decide(fields({ cliente: "FUNDO PARA O DESENVOLVIMENTO DA EDUCAÇÃO", intragov: "Sim", tipoIncidencia: "DDR" })).codigoBaixa, "2A011", "FED prevalece sobre Intragov e DDR");
  assert.equal(rules.decide({ cliente: "FED" }).codigoBaixa, "2A011", "A sigla FED determina 2A011 mesmo sem os demais campos");
  assert.equal(rules.decide(fields({ cliente: "CEDRO CONSTRUTORA E INCORPORADORA LTDA" })).codigoBaixa, "2A011", "2A011 não depende de cliente específico");
  assert.equal(rules.decide(fields({ cliente: "" })).codigoBaixa, "2A011", "Cliente ausente não impede 2A011 quando abertura e procedência determinam o código");
  const sai = rules.decide(fields({ cliente: "CEDRO", intragov: "Sim", servicoAfetado: "SAI - Serviço de Acesso à Internet" }));
  assert.equal(sai.codigoBaixa, "6Y200");
  assert.equal(sai.diagnostico, "00000017 Testado OK", "SAI também deve usar o diagnóstico 17");
  assert.equal(rules.decide(fields({ tipoIncidencia: "DADOS", cliente: "CEDRO" })).diagnostico, "00000017 Testado OK", "Incidência não DDR deve continuar no diagnóstico 17");
  assert.equal(rules.decide(fields({ tipoIncidencia: "DDR", cliente: "CEDRO", servicoAfetado: "SAI - Serviço de Acesso à Internet" })).diagnostico, "00000032 Testado OK", "DDR deve usar diagnóstico 32");
  assert.equal(rules.decide(fields({ cliente: "CEDRO", tipoIncidencia: "DADOS", tipoAbertura: "INICIAL", procedencia: "INDEFINIDA" })).allowed, false);

  const clean = helpers.buildAIPayload(fields({ numeroChamado: "987654", dataObjetivo: "segredo" }));
  assert.deepEqual(Object.keys(clean).sort(), ["cliente", "intragov", "procedencia", "servicoAfetado", "tipoAbertura", "tipoIncidencia"].sort());
  assert.equal(clean.intragov, false);
  assert.equal(helpers.buildAIPayload(fields({ intragov: "desconhecido" })).intragov, null);
  assert.equal(helpers.escapeCsv("=1+1"), "\"'=1+1\"");
  assert.equal(helpers.escapeCsv("  @SUM(A1:A2)"), "\"'  @SUM(A1:A2)\"");
  assert.equal((await aiService.analyzeCase(fields(), { provider: "gemini", apiKey: "" })).available, false);

  const contentSourceForDiagnosis = fs.readFileSync(path.join(base, "content/content.js"), "utf8");
  assert.ok(contentSourceForDiagnosis.includes('const diagnostico = incidence === "ddr" ? "00000032 Testado OK" : "00000017 Testado OK";'), "Seleção manual/aprendida deve preservar diagnóstico 32 para DDR");

  const verdict = {
    codigoBaixa: "2A011", diagnostico: "00000017 Testado OK", motivo: "Inicial + Reativo", confianca: 0.98, podeExecutar: true,
    normalizedFields: rules.canonicalize(fields())
  };
  assert.equal(aiSchema.validateDecision(verdict).codigoBaixa, "2A011");
  const ddrVerdict = { ...verdict, diagnostico: "00000032 Testado OK", normalizedFields: rules.canonicalize(fields({ tipoIncidencia: "DDR" })) };
  assert.equal(aiSchema.validateDecision(ddrVerdict).diagnostico, "00000032 Testado OK", "Schema da IA deve aceitar o diagnóstico 32 para DDR");
  assert.throws(() => aiSchema.validateDecision({ ...verdict, diagnostico: "00000039 Testado OK" }), /Código ou diagnóstico fora da lista/);
  assert.throws(() => aiSchema.validateDecision({ ...verdict, codigoBaixa: "99999" }), /fora da lista/);
  assert.equal(validation.compareAIWithRules({ available: true, decision: verdict, provider: "Gemini" }, rules.decide(fields())).allowed, true);
  assert.equal(validation.compareAIWithRules({ available: true, decision: { ...verdict, codigoBaixa: "57033" } }, rules.decide(fields())).status, "DIVERGÊNCIA IA × REGRAS");
  assert.equal(validation.compareAIWithRules({ available: false, reason: "sem conexão" }, rules.decide(fields())).status, "FALLBACK DETERMINÍSTICO");

  const originalFetch = global.fetch;
  let groqRequest;
  global.fetch = async (url, options) => {
    groqRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(verdict) } }] })
    };
  };
  const groqResult = await aiProvider.request({
    provider: "groq",
    apiKey: "test-key-not-real",
    model: "openai/gpt-oss-120b",
    temperature: 0,
    payload: clean
  });
  global.fetch = originalFetch;
  assert.equal(groqRequest.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(groqRequest.options.headers.authorization, "Bearer test-key-not-real");
  assert.deepEqual(groqRequest.body.response_format, { type: "json_object" });
  assert.equal(groqRequest.body.model, "openai/gpt-oss-120b");
  assert.ok(groqRequest.body.messages.every(message => message.content.toLowerCase().includes("json")), "Groq JSON mode requer menção explícita a json nas mensagens");
  assert.ok(groqRequest.body.messages[1].content.endsWith(JSON.stringify(clean)), "O adaptador Groq recebe apenas o payload allowlisted, precedido por instrução de formato");
  assert.deepEqual(aiSchema.validateDecision(groqResult).normalizedFields, rules.canonicalize(fields()));
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { code: "json_validate_failed", message: "Failed to generate JSON. Please adjust your prompt." } })
  });
  await assert.rejects(aiProvider.request({ provider: "groq", apiKey: "test-key-not-real", model: "openai/gpt-oss-120b", temperature: 0, payload: clean }), /Groq não conseguiu gerar uma resposta JSON válida/);
  const unavailableAI = await aiService.analyzeCase(fields(), { provider: "groq", apiKey: "test-key-not-real", model: "openai/gpt-oss-120b" });
  const fallbackDecision = validation.compareAIWithRules(unavailableAI, rules.decide(fields()));
  assert.equal(fallbackDecision.allowed, true, "JSON inválido do Groq deve permitir fallback se as regras locais aprovarem");
  assert.equal(fallbackDecision.status, "FALLBACK DETERMINÍSTICO");
  assert.match(unavailableAI.reason, /motor determinístico local/);
  global.fetch = originalFetch;

  assert.equal(dateHandler.repairFromCreation(fields()), "02/10/2026 10:00", "Data de Reparo deve ser criada duas horas após Data Criação");
  assert.equal(dateHandler.midpointBetweenDates("02/10/2026 08:00", "02/10/2026 10:00"), "02/10/2026 09:00", "Encerramento deve usar o meio entre Data Criação e Data de Reparo original");
  assert.equal(dateHandler.parseDate("2026-10-02").getDate(), 2, "Campo HTML date deve aceitar o formato ISO sem hora");
  assert.equal(dateHandler.repairFromCreation(fields({ dataCriacao: "28/09/26 19:51" })), "28/09/2026 21:51", "Data Criação com ano de dois dígitos deve ser aceita");
  assert.equal(dateHandler.validateDates(fields()).valid, true);
  assert.equal(dateHandler.validateDates({ ...fields(), dataReparoOriginal: "02/10/2026 10:00" }).repairValue, "02/10/2026 09:00", "Data do Encerramento deve usar uma hora após a Criação, sem copiar a Data de Reparo original");
  assert.match(dateHandler.validateDates(fields({ dataCriacao: "02/10/2026 10:00", dataObjetivo: "02/10/2026 11:00" })).reason, /anterior à Data Objetivo/);
  assert.equal(dateHandler.validateDates(fields({ dataCriacao: "02/10/2026 11:00", dataObjetivo: "02/10/2026 14:00" })).valid, true, "Início do SLA não é usado para bloquear o reparo calculado");
  const adjustedForPause = dateHandler.validateDates(fields({ paradaRelogio: "Sim", dataParadaRelogio: "02/10/2026 09:00" }));
  assert.equal(adjustedForPause.valid, true, "Pausa de Relógio deve ajustar a Data de Reparo para antes da pausa");
  assert.equal(adjustedForPause.repairValue, "02/10/2026 08:59", "Data de Reparo deve usar o último minuto antes da pausa");
  assert.ok(dateHandler.parseDate(adjustedForPause.repairValue).getTime() < dateHandler.parseDate("02/10/2026 09:00").getTime(), "Data de Reparo ajustada deve ser anterior à parada de relógio");
  assert.equal(dateHandler.validateDates(fields({ paradaRelogio: "Sim", dataParadaRelogio: "02/10/2026 11:00" })).valid, true, "Data de Reparo deve ser aceita quando anterior à pausa");
  assert.equal(dateHandler.validateDates(fields({ paradaRelogio: "desconhecida" })).valid, true, "Pausa não confirmada não impede o fluxo");
  assert.match(dateHandler.validateDates(fields({ dataCriacao: "", dataReparo: "" })).reason, /Data Criação não identificada/);

  const queued = await queue.runSequential([1, 2, 3], async value => {
    if (value === 2) throw new Error("simulated");
    return value * 2;
  });
  assert.deepEqual(queued.map(item => item.ok), [true, false, true], "Falha em lote não deve bloquear próximos itens seguros");
  let stopped = false;
  const stoppedQueue = await queue.runSequential([1, 2], async value => value, { shouldStop: () => stopped, onResult: () => { stopped = true; } });
  assert.equal(stoppedQueue.length, 1);

  const fakeData = { baixaHistory: [] };
  global.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get(keys, callback) {
        setImmediate(() => callback(typeof keys === "string" ? { [keys]: fakeData[keys] } : { ...fakeData }));
      },
      set(values, callback) {
        setImmediate(() => { Object.assign(fakeData, values); callback(); });
      }
    } }
  };
  await Promise.all(Array.from({ length: 20 }, (_, index) => storage.addHistory({ numeroChamado: String(index) })));
  assert.equal(fakeData.baixaHistory.length, 20, "Gravações concorrentes devem manter todo o histórico");
  fakeData.baixaSettings = {
    provider: "groq",
    apiKeys: { gemini: "gemini-test-key", groq: "groq-test-key" },
    model: "openai/gpt-oss-120b"
  };
  assert.equal((await storage.getSettings()).apiKey, "groq-test-key", "A seleção Groq deve usar apenas sua própria chave");
  fakeData.baixaSettings.provider = "gemini";
  assert.equal((await storage.getSettings()).apiKey, "gemini-test-key", "A seleção Gemini deve usar apenas sua própria chave");
  const learningCase = fields({ cliente: "ABC", tipoIncidencia: "DADOS", intragov: "Sim" });
  assert.equal(await storage.getLearnedCode(learningCase), null, "Combinação ainda não aprendida deve pedir confirmação");
  await storage.saveLearnedCode(learningCase, "6Y200");
  const learned = await storage.getLearnedCode({ ...learningCase, cliente: "DFG", tipoAbertura: "Inicial", intragov: true, numeroChamado: "999999" });
  assert.equal(learned.codigoBaixa, "6Y200", "Código aprendido deve ser reutilizado entre clientes não SEDUC com os mesmos campos decisivos");
  assert.equal(learned.ocorrencias, 1);
  await assert.rejects(storage.saveLearnedCode(learningCase, "12345"), /fora da lista permitida/);

  const originalDocumentsForDiagnosis = navigation.documents;
  const originalControlsForDiagnosis = navigation.controlsFor;
  const previousDocumentForDiagnosis = global.document;
  const staleDiagnosisField = {
    tagName: "INPUT", type: "text", value: "", disabled: false, readOnly: false,
    getClientRects: () => [{ width: 180, height: 24 }], getAttribute: () => null, labels: []
  };
  const selectedDiagnosisField = {
    ...staleDiagnosisField, value: "00000017 - Testado OK"
  };
  let currentDiagnosisField = staleDiagnosisField;
  const diagnosisOption = {
    textContent: "00000017", disabled: false, getAttribute: () => null,
    getClientRects: () => [{ width: 100, height: 24 }],
    click() { currentDiagnosisField = selectedDiagnosisField; }
  };
  const diagnosisDocument = {
    querySelectorAll(selector) {
      if (selector.startsWith("a, button")) return [diagnosisOption];
      if (selector.startsWith("input:not")) return [currentDiagnosisField];
      return [];
    }
  };
  global.document = diagnosisDocument;
  navigation.documents = () => [diagnosisDocument];
  navigation.controlsFor = () => [currentDiagnosisField];
  assert.equal(await formHandler.selectDiagnosisFromLookup("00000017 Testado OK", () => false, staleDiagnosisField), true,
    "A confirmação do diagnóstico deve acompanhar o novo input renderizado após selecionar a opção");
  navigation.documents = originalDocumentsForDiagnosis;
  navigation.controlsFor = originalControlsForDiagnosis;
  if (previousDocumentForDiagnosis === undefined) delete global.document;
  else global.document = previousDocumentForDiagnosis;

  const originalDocumentsForCertification = navigation.documents;
  const originalClickTabForCertification = navigation.clickTab;
  const originalWaitForLoadingForCertification = navigation.waitForLoadingToFinish;
  function certificationSelect(value, optionValues) {
    return {
      tagName: "SELECT", disabled: false, readOnly: false, _value: value, options: optionValues,
      get value() { return this._value; },
      set value(next) { this._value = next; },
      get selectedOptions() { return this.options.filter(option => option.value === this._value); },
      getClientRects: () => [{ width: 180, height: 24 }], dispatchEvent() { return true; }
    };
  }
  const placeholder = { value: "", textContent: "Selecione um status da lista" };
  const sim = { value: "S", textContent: "Sim" };
  const notApplicable = { value: "NA", textContent: "Não se aplica" };
  const no = { value: "N", textContent: "Não" };
  const labeled = (label, value, options) => {
    const select = certificationSelect(value, options);
    select.getAttribute = name => name === "aria-label" ? label : "";
    return select;
  };
  const gerencia = labeled("Circuito é passível de gerência?", "", [placeholder, sim, no]);
  const medicoes = labeled("Medições", "", [placeholder, sim, no, { value: "P", textContent: "Parcial" }]);
  const roteador = labeled("Roteador", "", [placeholder, { value: "C", textContent: "Cliente" }, notApplicable]);
  const modem = labeled("Gerência de Modem", "", [placeholder, { value: "A", textContent: "Aplica" }, notApplicable]);
  const modemCliente = labeled("Modem Cliente", "", [placeholder, { value: "C", textContent: "Cliente" }, notApplicable]);
  const tx = labeled("TX", "", [placeholder, { value: "A", textContent: "Aplica" }, notApplicable]);
  const dg = labeled("DG", "", [placeholder, { value: "A", textContent: "Aplica" }, notApplicable]);
  const extra = labeled("Outro campo qualquer", "", [placeholder, sim, no]);
  const allCertification = [extra, gerencia, medicoes, roteador, modem, modemCliente, tx, dg];
  const certificationDocument = { querySelectorAll: selector => selector === "select" ? allCertification : [] };
  navigation.documents = () => [certificationDocument];
  const preparedTabs = [];
  navigation.clickTab = async name => { preparedTabs.push(name); return true; };
  navigation.waitForLoadingToFinish = async () => true;
  const certificationFix = await formHandler.fixCertificationValidation();
  assert.equal(certificationFix.changed, 7, "Deve preencher os sete campos da Certificação");
  assert.equal(gerencia.value, "N", "Circuito é passível de gerência? = Não");
  assert.equal(medicoes.value, "N", "Medições = Não");
  for (const item of [roteador, modem, modemCliente, tx, dg]) assert.equal(item.value, "NA", "Demais campos = Não se aplica");
  assert.equal(extra.value, "", "Campos fora da lista (Selecione um item da lista) não devem ser preenchidos");

  const secondRun = await formHandler.fixCertificationValidation();
  assert.equal(secondRun.changed, 0, "Campos já preenchidos não devem ser alterados de novo");

  for (const item of allCertification) item._value = "";
  preparedTabs.length = 0;
  const prepared = await formHandler.prepareCertificationForSave();
  assert.equal(prepared.changed, 7);
  assert.equal(extra.value, "");
  assert.deepEqual(preparedTabs, ["Certificação", "Encerramento"], "A pré-validação deve conferir Certificação antes de voltar ao Encerramento");
  navigation.documents = originalDocumentsForCertification;
  navigation.clickTab = originalClickTabForCertification;
  navigation.waitForLoadingToFinish = originalWaitForLoadingForCertification;

  const manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.description.length <= 132, "A descrição da extensão deve respeitar o limite do Chrome Web Store");
  assert.ok(manifest.permissions.includes("storage") && manifest.permissions.includes("activeTab") && manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("tabs"), "O processamento de listas precisa identificar e fechar guias de tickets");
  assert.ok(manifest.icons?.[16] && manifest.icons?.[48] && manifest.icons?.[128] && manifest.action?.default_icon?.[16], "O manifesto deve oferecer ícones PNG estáticos para o Chrome, inclusive a página de detalhes da extensão");
  for (const iconPath of Object.values(manifest.icons || {})) assert.ok(fs.existsSync(path.join(base, iconPath)), `Ícone não encontrado: ${iconPath}`);
  for (const script of manifest.content_scripts[0].js) assert.ok(fs.existsSync(path.join(base, script)), `Script de conteúdo ausente: ${script}`);
  for (const file of ["background/background.js", "ai/ai-service.js", "ai/ai-provider.js", "ai/ai-schema.js", "automation/form-handler.js", "automation/baixa-handler.js", "automation/batch-handler.js", "options/options.html"]) {
    assert.ok(fs.existsSync(path.join(base, file)), `Arquivo do projeto ausente: ${file}`);
  }
  const source = fs.readFileSync(path.join(base, "utils/helpers.js"), "utf8");
  assert.ok(source.includes("buildAIPayload"), "Payload de IA deve ser explicitamente allowlisted.");
  const aiProviderSource = fs.readFileSync(path.join(base, "ai/ai-provider.js"), "utf8");
  assert.ok(aiProviderSource.includes("não controla o navegador") && aiProviderSource.includes("classificar os campos"), "O prompt deve limitar a IA à classificação e deixar os cliques para a automação local.");
  const navigationSource = fs.readFileSync(path.join(base, "automation/navigation.js"), "utf8");
  assert.ok(navigationSource.includes("[onclick]") && navigationSource.includes("td, th, li, span, div"), "A navegação precisa cobrir as abas legadas do SIGITM");
  assert.ok(navigationSource.includes("Tipo abertura") && navigationSource.includes("Tipo incidencia"), "Os rótulos de tipo devem refletir o cabeçalho real da página");
  const background = fs.readFileSync(path.join(base, "background/background.js"), "utf8");
  assert.ok(background.includes("DIVERGÊNCIA IA") || background.includes("BaixaValidation.compareAIWithRules"));
  assert.ok(background.includes("BaixaRules.automaticCodeForClient(data.cliente)") && background.includes('status: "REGRA PRIORITÁRIA DO CLIENTE"'), "SEDUC/FED devem ignorar divergências da IA e manter a regra automática 2A011");
  assert.ok(background.includes("chrome.scripting.executeScript") && background.includes("await injectContent(tabId)"), "Se não houver receptor, o background deve reinjetar o content script na aba SIGITM atual.");
  assert.ok(fs.readFileSync(path.join(base, "content/content.js"), "utf8").includes("__BAIXADOR_AUTOMATICO_V8__"), "A reinjeção deve identificar o controller atualizado.");
  assert.ok(background.includes("GET_BAIXADOR_CONTENT_STATUS") && background.includes("START_ANALYSIS_V8"), "O background deve confirmar a versão atual do content script antes de iniciar a automação.");
  assert.ok(background.includes("BaixaRunGuard.authorizeRun") && background.includes('"run-guard.js"'), "O background deve aplicar o guard para lock persistido e runId efêmero.");
  assert.ok(background.includes("TEST_AI_API") && background.includes("dados sintéticos"), "Teste de API deve usar somente dados fictícios e nunca dados de um chamado.");
  assert.ok(background.includes("baixaAiConnectionStatus") && fs.readFileSync(path.join(base, "popup/popup.html"), "utf8").includes("aiStatusTitle"), "O resultado de configuração/teste da IA deve aparecer no popup da extensão.");
  assert.ok(JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8")).host_permissions.includes("https://api.groq.com/*"));
  const optionsMessage = background.slice(background.indexOf('message?.type === "GET_OPTIONS"'), background.indexOf('message?.type === "TEST_AI_API"'));
  assert.ok(!optionsMessage.includes("apiKeys:") && !optionsMessage.includes("settings: { ...settings"), "GET_OPTIONS não pode serializar o mapa de chaves à página de opções.");
  assert.ok(background.includes("current.tabId === tab.id") && background.includes("STOP_AUTOMATION"), "Uma nova análise explícita na mesma guia deve substituir um lock antigo.");
  assert.ok(background.includes("waitForTicketTabChange(previousTabs") && background.includes("previous.url !== tab.url") && background.includes("tab.active && !previous.active"), "A fila deve identificar novas guias e guias SIGITM existentes reutilizadas pelo sistema");
  assert.ok(background.includes("if (!clickResult?.clicked)"), "O coordenador deve verificar a propriedade clicked retornada pelo clique MAIN-world, não uma propriedade ok inexistente");
  assert.ok(background.includes("await returnToListAndRefresh(batch)") && background.includes("await activateTab(batch.listTabId)"), "Após cada ticket, deve voltar à guia da tabela e atualizar antes de abrir o próximo");
  assert.ok(background.includes("CONTINUE_MASSIVE_LIST") && background.includes("MASSIVE_LIST_URL") && background.includes("continueMassiveListFromTicket"), "Ticket individual liberado deve voltar à consulta 95803, atualizar e iniciar o próximo BD");
  assert.ok(!background.slice(background.indexOf("async function finishBatch"), background.indexOf("async function processNextBatchTicket")).includes("chrome.tabs.remove"), "Falhas genéricas da fila nunca devem fechar a guia do ticket antes da confirmação explícita");
  assert.ok(background.includes('const listName = BaixaBatch.listName(url.href)') && background.includes("startBatchForTab(tab.id, listName)"), "O botão Baixar automaticamente deve detectar e iniciar o lote quando a guia ativa for uma das tabelas SIGITM");
  assert.ok(background.includes("chrome.action.setIcon") && background.includes("function makeToolbarIcon(size)") && background.includes("#e3262e"), "O ícone da extensão deve mostrar o globo azul em aro verde-amarelo com X vermelho");
  assert.ok(background.includes("automationActive") && background.includes("activeBatch && !activeBatch.finished"), "O estado do popup deve saber quando um processamento em lista está ativo mesmo entre dois tickets");
  assert.ok(JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8")).name === "Baixador Automático v3", "A extensão deve aparecer como versão 3 no Chrome");
  assert.ok(!fs.readFileSync(path.join(base, "popup/popup.html"), "utf8").includes("executeBatch") && !fs.readFileSync(path.join(base, "popup/popup.js"), "utf8").includes("RUN_BATCH_ACTIVE_TAB"), "Não deve existir um botão separado para processar a lista");
  const contentSource = fs.readFileSync(path.join(base, "content/content.js"), "utf8");
  assert.ok(contentSource.includes('BaixaHandler.findUniqueButton(["Atualizar"]).click()') && contentSource.includes("sawLoader ? 400 : 1800"), "O retorno à tabela deve acionar Atualizar e aguardar o carregamento/estabilização da lista");
  assert.ok(background.includes('world: "MAIN"') && background.includes("async function clickSequenceInPage") && background.includes("await new Promise(resolve => setTimeout(resolve, 250))") && background.includes("target.dispatchEvent(new MouseEvent(\"dblclick\""), "A página SIGITM deve receber dois cliques separados por 250 ms no contexto principal para executar o próprio handler da sequência");
  assert.ok(contentSource.includes("runId: currentRunId") && contentSource.includes("finishedRunId") && contentSource.includes("__BAIXADOR_AUTOMATICO_V8__") && contentSource.includes("GET_BAIXADOR_CONTENT_STATUS"), "O content script deve identificar mensagens da execução correspondente e a versão do listener.");
  assert.ok(contentSource.includes("sendResponse({ ok: true, started: true, runId: message.runId })"), "O novo content script precisa confirmar a mensagem de início para o background não reinjetar e fechar o ticket.");
  assert.ok(contentSource.includes("BaixaHandler.beginMainClosure(stopCheck)"), "O fluxo automático deve executar a etapa inicial de Bloquear e Baixar");
  assert.ok(contentSource.includes("Confirme o código de baixa") && contentSource.includes('type: "SAVE_CODE_LEARNING"'), "O fluxo automático deve perguntar e salvar localmente a escolha do código");
  assert.ok(contentSource.includes('data-case-field="tipoAbertura"') && contentSource.includes('data-case-field="procedencia"') && contentSource.includes('data-case-field="cliente"') && contentSource.includes('data-case-field="intragov"') && contentSource.includes('data-case-field="tipoIncidencia"') && contentSource.includes('data-case-field="servicoAfetado"') && contentSource.includes('"Marcada (Sim)"') && contentSource.includes('"Desmarcada (Não)"'), "A pergunta deve exibir os campos de regra e estado marcado/desmarcado do Intragov");
  assert.ok(fs.readFileSync(path.join(base, "background/background.js"), "utf8").includes('message?.type === "SAVE_CODE_LEARNING"'), "O background deve validar e persistir a escolha do código do usuário");
  assert.ok(contentSource.indexOf("BaixaHandler.beginMainClosure(stopCheck)") < contentSource.indexOf("BaixaFormHandler.fillDiagnosis(decision, stopCheck)"), "Diagnóstico deve ser preenchido somente após Bloquear, fechar o popup e Baixar");
  assert.ok(contentSource.indexOf("BaixaFormHandler.fillClosure(") < contentSource.indexOf("BaixaFormHandler.prepareCertificationForSave(stopCheck)"), "A Certificação deve ser pré-validada depois do Encerramento e antes do envio");
  assert.ok(contentSource.indexOf("BaixaFormHandler.prepareCertificationForSave(stopCheck)") < contentSource.indexOf("BaixaHandler.saveMainClosure(stopCheck)"), "Gravar Baixa só pode ocorrer depois de validar a Certificação");
  assert.ok(contentSource.includes("BaixaDateHandler.validateDates(data)"), "Data de Reparo deve ser calculada e validada antes de alterar o chamado");
  assert.ok(fs.readFileSync(path.join(base, "automation/form-handler.js"), "utf8").includes('"Data do Reparo", "Dt Reparo", "Dt. Reparo"'), "Encerramento deve reconhecer variações legadas de Data de Reparo");
  const formHandlerSource = fs.readFileSync(path.join(base, "automation/form-handler.js"), "utf8");
  assert.ok(formHandlerSource.includes("async function fillRepairDate") && formHandlerSource.includes("await fillRepairDate(dataReparo, shouldStop)") && formHandlerSource.includes("setValue(field, expected, { allowLocked: true })"), "Data de Reparo deve ser preenchida inclusive se SIGITM marcar o campo como readonly/disabled e depois verificada");
  const closureSource = formHandlerSource.slice(formHandlerSource.indexOf("async function fillClosure"));
  assert.ok(!closureSource.includes("serviceAliases") && !closureSource.includes("servicoAfetado"), "Serviço Afetado não deve ser preenchido no Encerramento");
  assert.ok(formHandlerSource.includes("function phoneValuesForLayout(intragov, count)"), "Os valores de telefone devem adaptar-se aos layouts físicos com dois ou três inputs");
  assert.ok(!formHandlerSource.includes('fillBestEffort(["Intragov"], intragov ? "Sim" : "Não", skippedFields, { blur: true })'), "Encerramento não deve procurar Intragov, pois o checkbox pertence à aba Definição");
  assert.ok(formHandlerSource.includes("function verifyClosureValues(intragov)") && formHandlerSource.includes("await waitForClosureValues(intragov, shouldStop)") && formHandlerSource.includes("Encerramento não confirmou todos os campos"), "A automação não deve acionar Gravar Baixa se os Telefones não persistirem após o blur");
  assert.ok(formHandlerSource.includes('if (options.blur || options.allowLocked) control.dispatchEvent(new EventType("blur"))') && formHandlerSource.includes('setValue(control, values[index], { blur: true })'), "Os campos de Encerramento devem disparar blur para confirmar valores em formulários legados SIGITM");
  assert.ok(contentSource.includes("uncertain: Boolean(batch)"), "Qualquer falha de preenchimento em lote deve pausar e manter o ticket aberto, nunca fechá-lo/avançar sem baixa confirmada");
  assert.ok(formHandlerSource.includes("const expectedPhones = phoneValuesForLayout(intragov, phoneControls.length)"), "Deve confirmar os zeros/xx nos campos Telefone após preencher o Encerramento");
  assert.ok(formHandlerSource.includes('fillBestEffort(["Responsável"], "xx"'), "Responsável deve receber xx no Encerramento");
  assert.ok(formHandlerSource.includes('fillBestEffort(["Descrição"], "xx"') && formHandlerSource.includes('fillBestEffort(["Técnico"], "xx"') && formHandlerSource.includes('fillBestEffort(["Área Técnica"], "xx"'), "Todos os campos amarelos definidos devem receber xx");
  const baixaHandlerSource = fs.readFileSync(path.join(base, "automation/baixa-handler.js"), "utf8");
  assert.ok(baixaHandlerSource.includes('fill(["Responsável"], "xx")') && baixaHandlerSource.includes('fill(["Descrição"], "xx")'), "Os campos da guia Acionamento devem receber xx");
  assert.ok(formHandlerSource.includes("function closurePhoneControls()") && formHandlerSource.includes("isYellowField") && formHandlerSource.includes("yellow.length === 3"), "A automação deve reconhecer os três inputs amarelos de telefone do layout atual e ignorar os brancos históricos");
  assert.ok(formHandlerSource.includes("waitForBaixaCodeField") && formHandlerSource.includes("Código Completo Baixa"), "Encerramento deve aguardar e reconhecer variações do campo de código");
  assert.ok(formHandlerSource.includes("selectDiagnosisFromLookup") && formHandlerSource.includes("clickLookupAdjacentTo(field, \"Diagnóstico\""), "Diagnóstico deve abrir a lupa e selecionar o código definido pelas regras");
  assert.ok(formHandlerSource.includes("waitForDiagnosisField") && formHandlerSource.includes("mesma altura"), "Diagnóstico deve aguardar o campo e localizar o input pelo rótulo no layout legado");
  assert.ok(formHandlerSource.includes("[code, description]") && formHandlerSource.includes("diagnosisField || await waitForDiagnosisField"), "Após a seleção, Diagnóstico deve aceitar Testado OK e confirmar o mesmo campo usado na lupa");
  assert.ok(!contentSource.includes("BaixaHandler.confirmMainClosure(stopCheck)"), "O fluxo não deve clicar Baixar novamente após preencher Encerramento");
  assert.ok(contentSource.includes("BaixaHandler.saveMainClosure(stopCheck)") && contentSource.includes('resultLabel = "GRAVAR BAIXA ACIONADO"'), "Após preencher Encerramento, o fluxo individual deve acionar Gravar Baixa automaticamente");
  assert.ok(contentSource.includes('type: "CONTINUE_MASSIVE_LIST"') && contentSource.includes("Ticket liberado. Voltando à Validação Massiva"), "Após Ticket liberado em execução individual, deve retornar e continuar a lista 95803");
  const batchSubmitFlow = contentSource.slice(contentSource.indexOf('notify("Certificação preenchida e confirmada. Agora sim, acionando Gravar Baixa…")'), contentSource.indexOf('const resultRecord = makeRecord(data, decision, resultLabel)'));
  assert.ok(batchSubmitFlow.includes("await BaixaHandler.waitForTicketReleased(30000, stopCheck)") && !batchSubmitFlow.includes("waitForLoadingToFinish"), "Após Gravar Baixa, a confirmação Tíquete Liberado deve ser verificada antes de qualquer espera por loaders que podem confundir o ícone de sucesso com carregamento");
  assert.ok(background.includes("BaixaDateHandler") || contentSource.includes("BaixaDateHandler.validateDates"), "Data de Reparo deve ser validada contra Data Objetivo, pausa e SLA antes da baixa");
  assert.ok(fs.readFileSync(path.join(base, "automation/date-handler.js"), "utf8").includes("Data de Reparo deve ser posterior à Data Criação."), "Data de Reparo deve ficar depois da Data Criação antes de permitir a baixa");
  assert.ok(fs.readFileSync(path.join(base, "automation/baixa-handler.js"), "utf8").includes('closeBlockPopup(shouldStop, "Baixar")'), "Popup informativo após Baixar deve ser fechado pelo X antes do Encerramento");
  assert.ok(baixaHandlerSource.includes("closeValidationErrorPopup") && baixaHandlerSource.includes("rich-mpnl-panel") && contentSource.includes("abrindo a aba Certificação"), "Erro Validation Error no popup RichFaces deve fechar antes de abrir Certificação");
  assert.ok(formHandlerSource.includes("Circuito é passível de gerência?"), "Certificação deve responder somente Circuito é passível de gerência? e confirmar o resultado");
  assert.ok(baixaHandlerSource.includes('await waitForUniqueButton(["Baixar"], 10000, shouldStop)'), "Após Bloquear, a automação deve aguardar o botão Baixar aparecer antes de clicar");
  assert.ok(baixaHandlerSource.includes("popupClosedAfterClick") && !baixaHandlerSource.includes('await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);\n    return true;'), "Após fechar o popup de Baixar, a automação deve confirmar o fechamento sem bloquear no loader central");
  assert.ok(baixaHandlerSource.includes("waitForTicketReleased") && baixaHandlerSource.includes("await root.BaixaHelpers.sleep(400)"), "A guia de ticket em lote deve aguardar o modal visível de Tíquete Liberado e sua estabilização antes de fechar");
  assert.ok(baixaHandlerSource.includes("root.BaixaNavigation.textOf(doc.body)") && baixaHandlerSource.includes("(?:ticket|tiquete)"), "A confirmação SIGITM “Tíquete Liberado” deve ser identificada pelo texto inteiro do modal antes de fechar a guia");
  assert.ok(baixaHandlerSource.includes("×|✕|✖|✗|✘") && baixaHandlerSource.includes("const rawLower = raw.toLowerCase()") && baixaHandlerSource.includes("selectBestPopupCloseControl"), "O detector de popup deve reconhecer X em Unicode e escolher automaticamente o fechamento no canto superior direito");
  assert.ok(baixaHandlerSource.includes("MutationObserver") && baixaHandlerSource.includes("popupCloseObserved") && baixaHandlerSource.includes("validationErrorPopup()"), "A validação do Gravar Baixa deve sobreviver ao fechamento manual do popup pelo usuário");
  assert.ok(navigationSource.includes("waitForTabActivation") && navigationSource.includes("certificationControlsVisible"), "A aba Certificação deve ser aguardada até o conteúdo ficar disponível");
  assert.ok(fs.readFileSync(path.join(base, "background/background.js"), "utf8").includes("baixaLiveStatus") && background.includes("AUTOMATION_STATUS"), "O popup deve receber o status vivo da automação");
  const popupSource = fs.readFileSync(path.join(base, "popup/popup.js"), "utf8");
  assert.ok(fs.readFileSync(path.join(base, "popup/popup.html"), "utf8").includes('id="brandLogo"') && popupSource.includes("function setupLogo"), "A logo do popup deve ter carregamento explícito e fallback");

  assert.ok(contentSource.includes("READ_BATCH_LIST_STATE") && contentSource.includes("BATCH_TICKET_FINISHED"), "O fluxo em lote deve ler a lista e notificar o resultado de cada ticket");
  assert.ok(popupSource.includes("A IA não é necessária para baixar") && popupSource.includes("se houver divergência, a baixa é bloqueada"), "A tela inicial deve explicar que IA é opcional e que divergência de IA conectada pode bloquear a baixa");
  assert.ok(popupSource.includes("Automação pausada") && popupSource.includes("Pausar automação") && popupSource.includes("Automação inativa"), "O botão de controle deve indicar claramente estados ativo, pausado e inativo");
  assert.ok(!fs.readFileSync(path.join(base, "popup/popup.html"), "utf8").includes("Chamado atual ou lista Seq"), "O botão principal deve permanecer curto, sem subtítulo explicativo longo");
  assert.ok(navigationSource.includes("waitForLoadingToFinish") && navigationSource.includes("loadingIndicators") && navigationSource.includes("isSmallStandalone"), "Navegação deve ignorar o pequeno loader central do SIGITM e bloquear somente overlays reais");
  const styleDocument = {
    defaultView: { innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ display: "block", visibility: "visible", position: "absolute" }) },
    querySelectorAll: () => []
  };
  const hiddenPanel = { hidden: false, ownerDocument: styleDocument, getClientRects: () => [{ width: 500, height: 300 }], getBoundingClientRect: () => ({ width: 500, height: 300 }), offsetParent: {} };
  styleDocument.defaultView.getComputedStyle = () => ({ display: "none", visibility: "hidden", position: "absolute" });
  assert.equal(navigation.visible(hiddenPanel), false, "Painel RichFaces oculto no DOM não deve ser tratado como popup aberto");
  const previousDocumentForLoader = global.document;
  const loaderDocument = {
    defaultView: { innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ display: "block", visibility: "visible", position: "absolute" }) },
    querySelectorAll: selector => selector.includes(".spinner") ? [smallLoader] : []
  };
  const smallLoader = { ownerDocument: loaderDocument, className: "spinner", id: "", hidden: false, offsetParent: {}, getClientRects: () => [{ width: 70, height: 70 }], getBoundingClientRect: () => ({ left: 465, top: 300, right: 535, bottom: 370, width: 70, height: 70 }), matches: selector => selector.includes(".spinner"), getAttribute: () => null };
  global.document = loaderDocument;
  assert.deepEqual(navigation.loadingIndicators(), [], "Loader central pequeno do SIGITM não deve travar a automação");
  const bigLoader = { ...smallLoader, className: "spinner overlay", getClientRects: () => [{ width: 900, height: 700 }], getBoundingClientRect: () => ({ left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700 }) };
  loaderDocument.querySelectorAll = selector => selector.includes(".spinner") ? [bigLoader] : [];
  assert.deepEqual(navigation.loadingIndicators(), [bigLoader], "Overlay de carregamento grande deve continuar sendo tratado como bloqueio");
  global.document = previousDocumentForLoader;
  assert.ok(navigationSource.includes("findTabCandidates(name)") && navigationSource.includes("Date.now() + 3200"), "A navegação deve aguardar a aba Cliente aparecer por uma janela curta");
  const notificationSource = fs.readFileSync(path.join(base, "ui/notifications.js"), "utf8");
  assert.ok(notificationSource.includes("Ampliar mensagem") && notificationSource.includes("Copiar erro") && notificationSource.includes("overflow-wrap:anywhere"), "Mensagens longas de erro devem poder ser ampliadas, roladas e copiadas");
  assert.ok(notificationSource.includes("}, remaining)") && notificationSource.includes("noticeMeta") && notificationSource.includes("icons/sigitm-v2-48.png") && !notificationSource.includes('class="close"'), "A notificação deve manter o estado da automação e exibir a logo sem botão X");
  assert.ok(manifest.web_accessible_resources?.[0]?.resources.includes("icons/sigitm-v2-48.png"), "A logo do aviso na página SIGITM deve ser um recurso acessível à página.");
  assert.ok(notificationSource.includes("function celebrate") && contentSource.includes("BaixaNotifications.celebrate"), "Ao terminar a lista sem BDs, a interface deve exibir confetes");
  assert.ok(notificationSource.includes("sessionStorage.setItem") && notificationSource.includes("function restore()") && notificationSource.includes("saved.expiresAt"), "O aviso deve ser restaurado no reload pelo tempo restante dos cinco segundos");
  assert.ok(notificationSource.includes("chrome.storage.local.set") && notificationSource.includes("chrome.storage.local.get"), "O aviso deve ser persistido no armazenamento da extensão para sobreviver ao reload do SIGITM");
  assert.ok(formHandlerSource.includes('clickTab("Definição", shouldStop)') && !formHandlerSource.includes('async function fixCertificationValidation(shouldStop = () => false) {\n    if (shouldStop()) throw new Error("Automação interrompida pelo usuário.");\n    await root.BaixaNavigation.waitForLoadingToFinish(shouldStop);'), "A aba Definição/Certificação deve prosseguir sem ficar presa pelo loader visual central");


  // ---- v3.0: regressões da correção de CSP, ponte MAIN e consistência ----
  const pkg = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "manifest.json e package.json devem ter a mesma versão");
  assert.equal(helpers.VERSION, manifest.version, "BaixaHelpers.VERSION deve acompanhar o manifest");
  const jsonSchema = aiProvider.toJsonSchema(aiSchema.outputSchema);
  assert.equal(jsonSchema.type, "object", "Schema enviado ao Gemini deve usar tipos JSON Schema em minúsculas");
  assert.equal(jsonSchema.properties.normalizedFields.properties.intragov.type, "boolean");
  assert.deepEqual(jsonSchema.properties.codigoBaixa.enum, aiSchema.outputSchema.properties.codigoBaixa.enum, "Enums não podem ser alterados");
  assert.equal(aiSchema.outputSchema.type, "OBJECT", "O schema interno não deve ser mutado");
  // ---- v3.1: estatísticas, filtro e gerenciador de códigos aprendidos ----
  const hist = [
    { dataHora: "2026-10-08T10:00:00Z", numeroChamado: "111111", codigoBaixa: "2A011", resultado: "TICKET LIBERADO", cliente: "ABC" },
    { dataHora: "2026-10-08T11:00:00Z", numeroChamado: "222222", codigoBaixa: "57033", resultado: "GRAVAR BAIXA ACIONADO" },
    { dataHora: "2026-10-07T09:00:00Z", numeroChamado: "333333", resultado: "BAIXA NÃO REALIZADA", erro: "Campo Técnico ambíguo" }
  ];
  const sum = helpers.summarizeHistory(hist);
  assert.deepEqual([sum.total, sum.success, sum.failed], [3, 2, 1]);
  assert.equal(Math.round(sum.successRate * 100), 67);
  assert.deepEqual(sum.byCode, { "2A011": 1, "57033": 1 });
  assert.equal(sum.byDay["2026-10-08"], 2);
  assert.equal(helpers.summarizeHistory(undefined).total, 0, "Histórico ausente não deve quebrar");
  assert.equal(helpers.filterHistory(hist, { text: "tecnico ambiguo" }).length, 1, "Busca ignora acentos e maiúsculas");
  assert.equal(helpers.filterHistory(hist, { result: "TICKET LIBERADO" }).length, 1);
  assert.equal(helpers.filterHistory(hist, {}).length, 3);
  const keyInfo = helpers.describeLearningKey(storage.codeLearningKey(learningCase));
  assert.equal(keyInfo.intragov, "Sim");
  assert.equal(helpers.describeLearningKey("não é json"), null);
  const listed = await storage.listLearnedCodes();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].codigoBaixa, "6Y200");
  const backup = JSON.parse(JSON.stringify(listed));
  assert.equal(await storage.deleteLearnedCode(listed[0].key), true, "Remover uma escolha errada");
  assert.equal((await storage.listLearnedCodes()).length, 0);
  const imp = await storage.importLearnedCodes([...backup, { key: "x", codigoBaixa: "6Y200" }, { key: backup[0].key, codigoBaixa: "99999" }, null]);
  assert.deepEqual(imp, { imported: 1, ignored: 3 }, "Importação descarta entradas inválidas");
  assert.equal((await storage.getLearnedCode(learningCase)).codigoBaixa, "6Y200", "Backup restaurado é reutilizado");
  await assert.rejects(storage.importLearnedCodes("lixo"), /Backup inválido/);
  await storage.clearLearnedCodes();
  assert.equal((await storage.listLearnedCodes()).length, 0);
  const bgForLearning = fs.readFileSync(path.join(base, "background/background.js"), "utf8");
  assert.ok(["LIST_LEARNING", "DELETE_LEARNING", "CLEAR_LEARNING", "IMPORT_LEARNING"].every(type => bgForLearning.includes(type)), "Background deve expor o gerenciador de códigos");
  assert.ok(/^3\./.test(manifest.version), "A versão do app deve ser 3.x");
  assert.equal(helpers.DEFAULT_MODELS.groq, aiProvider.defaults.groq, "Modelos padrão devem vir de uma única fonte");
  const protocolOf = file => fs.readFileSync(path.join(base, file), "utf8").match(/CONTENT_PROTOCOL = "([^"]+)"/)?.[1];
  assert.equal(protocolOf("content/content.js"), protocolOf("background/background.js"), "Protocolo do content script e do background devem coincidir");

  // Link X com href javascript: não pode navegar (CSP); onclick segue executando.
  const listeners = new Map();
  const cspLink = {
    getAttribute: name => name === "href" ? "javascript:fecharMensagem()" : "",
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: type => listeners.delete(type)
  };
  const release = baixaHandler.suppressJavascriptNavigation(cspLink);
  assert.ok(listeners.has("click"), "Deve instalar o guard de clique para href javascript:");
  let prevented = false;
  listeners.get("click")({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, "O guard deve cancelar a navegação javascript: bloqueada pela CSP");
  release();
  assert.equal(listeners.size, 0, "O guard deve ser removido após o clique");
  const plainLink = { getAttribute: () => "#", addEventListener: () => { throw new Error("não deve instalar guard"); }, removeEventListener() {} };
  assert.doesNotThrow(() => baixaHandler.suppressJavascriptNavigation(plainLink)(), "Links comuns não recebem guard");
  assert.deepEqual(baixaHandler.pageCloseRequest(cspLink, { id: "x" }), { kind: "function", value: "fecharMensagem" }, "Função simples deve ir para a ponte MAIN");
  assert.equal(baixaHandler.pageCloseRequest({ getAttribute: () => "javascript:alert(1)+1" }, { id: "x" }), null, "Expressões arbitrárias nunca viram pedido de fechamento");
  assert.deepEqual(baixaHandler.pageCloseRequest({ getAttribute: name => name === "onclick" ? "Richfaces.hideModalPanel('j_id1:painel')" : "" }, { id: "p" }), { kind: "richfaces", value: "j_id1:painel" });
  const bgSource = fs.readFileSync(path.join(base, "background/background.js"), "utf8");
  assert.ok(bgSource.includes("PAGE_CLOSE_POPUP") && bgSource.includes("BLOCKED_PAGE_FUNCTIONS") && bgSource.includes("baixaLiveStatus\", BATCH_STORAGE_KEY"), "Background deve atender a ponte MAIN e devolver o status vivo ao popup");
  assert.ok(bgSource.includes('startsWith(chrome.runtime.getURL(""))'), "senderIsExtension deve exigir página da própria extensão");
  assert.ok(fs.readFileSync(path.join(base, "popup/popup.js"), "utf8").includes("changes.baixaLiveStatus"), "Popup deve reagir ao status vivo");
  let slept = false;
  assert.equal(await helpers.waitFor(() => { slept = true; return "ok"; }, 50, () => false, 5), "ok");
  assert.equal(await helpers.waitFor(() => false, 20, () => false, 5), false, "waitFor devolve false ao estourar o tempo");
  await assert.rejects(helpers.waitFor(() => false, 50, () => true, 5), /interrompida/, "waitFor deve respeitar a parada");
  assert.ok(slept);

  console.log("All deterministic rules, AI schema, privacy, date, fallback, queue, and manifest tests passed.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
