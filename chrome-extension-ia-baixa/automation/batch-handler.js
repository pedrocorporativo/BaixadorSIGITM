(function (root) {
  "use strict";

  const LISTS = Object.freeze({
    "138550": "Ativos e Parados",
    "95803": "Validação Massiva"
  });

  function listIdFromUrl(url) {
    try { return new URL(url).searchParams.get("idConsulta") || ""; }
    catch { return ""; }
  }

  function listName(url) {
    return LISTS[listIdFromUrl(url)] || "";
  }

  function normalize(value) { return root.BaixaHelpers.normalizeText(value); }

  function sequenceHeaderIndex(cells) {
    return cells.findIndex(cell => {
      const label = normalize([root.BaixaNavigation.textOf(cell), cell.getAttribute?.("aria-label"), cell.getAttribute?.("title")]
        .filter(Boolean).join(" ").replace(/[↕↔↑↓⇅⇵▲▼]/g, " "));
      return label === "seq" || label.startsWith("seq ");
    });
  }

  function sequenceNumber(cell) {
    return normalize(root.BaixaNavigation.textOf(cell)).match(/\b\d{5,20}\b/)?.[0] || "";
  }

  function readListState(documents = root.BaixaNavigation.documents()) {
    const tickets = new Map();
    let explicitEmpty = false;
    for (const doc of documents) {
      const bodyText = normalize(doc.body?.innerText || doc.body?.textContent || "");
      if (/\bzero registros\b|\bnenhum registro\b|\bnenhum chamado\b|\b0 registros\b|\bnao existem registros\b|\bconsulta sem registros\b/.test(bodyText)) explicitEmpty = true;
      const tables = [...doc.querySelectorAll("table")];
      for (const table of tables) {
        const rows = [...table.querySelectorAll("tr")];
        const headerIndex = rows.findIndex(row => sequenceHeaderIndex([...row.querySelectorAll("th, td")]) >= 0);
        if (headerIndex < 0) continue;
        const headers = [...rows[headerIndex].querySelectorAll("th, td")];
        const sequenceIndex = sequenceHeaderIndex(headers);
        for (const row of rows.slice(headerIndex + 1)) {
          const cells = [...row.querySelectorAll("th, td")];
          const sequenceCell = cells[sequenceIndex];
          if (!sequenceCell) continue;
          const sequence = sequenceNumber(sequenceCell);
          if (sequence && root.BaixaNavigation.visible(sequenceCell)) tickets.set(sequence, sequence);
        }
      }
    }
    const recordCounts = documents.flatMap(doc => [...String(doc.body?.innerText || doc.body?.textContent || "").matchAll(/registros\s*:\s*(\d+)\s*de\s*(\d+)/gi)])
      .map(match => ({ shown: Number(match[1]), total: Number(match[2]) }));
    const recordCount = recordCounts.find(item => item.total > 0) || recordCounts[0] || null;
    const empty = explicitEmpty || Boolean(recordCount && recordCount.total === 0);
    return { tickets: [...tickets.keys()], empty, recordCount };
  }

  const api = { LISTS, listIdFromUrl, listName, sequenceHeaderIndex, sequenceNumber, readListState };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaBatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
