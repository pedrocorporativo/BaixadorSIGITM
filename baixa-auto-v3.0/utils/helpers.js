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
