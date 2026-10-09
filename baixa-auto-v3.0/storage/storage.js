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
