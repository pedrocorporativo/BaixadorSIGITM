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
