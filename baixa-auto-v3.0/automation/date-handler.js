(function (root) {
  "use strict";

  function parseDate(value) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
    const text = String(value ?? "").trim();
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/) ||
      text.match(/^(\d{4})-(\d{2})-(\d{2})$/) ||
      text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const br = text.includes("/");
    let year = Number(br ? match[3] : match[1]);
    if (br && year < 100) year += 2000;
    const month = Number(match[2]);
    const day = Number(br ? match[1] : match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    const date = new Date(year, month - 1, day, hour, minute, second);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day &&
      date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second ? date : null;
  }

  function addHours(date, hours) {
    return formatDate(new Date(date.getTime() + hours * 60 * 60 * 1000));
  }

  function formatDate(result) {
    const pad = value => String(value).padStart(2, "0");
    return `${pad(result.getDate())}/${pad(result.getMonth() + 1)}/${result.getFullYear()} ${pad(result.getHours())}:${pad(result.getMinutes())}`;
  }

  // Legado: mantido apenas por compatibilidade com testes e integrações. O
  // Encerramento usa validateDates(), que calcula Data Criação + 1 hora.
  function repairFromCreation(data) {
    const creation = parseDate(data.dataCriacao);
    return creation ? addHours(creation, 2) : "";
  }

  function midpointBetweenDates(startValue, endValue) {
    const start = parseDate(startValue);
    const end = parseDate(endValue);
    if (!start || !end || end.getTime() - start.getTime() < 2 * 60 * 1000) return "";
    // Arredonda para o minuto inferior para o formato aceito pelo SIGITM.
    const midpoint = new Date(Math.floor(((start.getTime() + end.getTime()) / 2) / 60000) * 60000);
    return midpoint.getTime() > start.getTime() && midpoint.getTime() < end.getTime() ? formatDate(midpoint) : "";
  }

  function validateDates(data) {
    const creation = parseDate(data.dataCriacao);
    const objective = parseDate(data.dataObjetivo);
    const originalRepair = parseDate(data.dataReparoOriginal);
    if (!creation) return { valid: false, reason: "Data Criação não identificada ou inválida; não é possível calcular Data de Reparo + 1 hora." };
    // Regra operacional: o Encerramento usa exatamente uma hora após a criação.
    // A Data de Reparo já existente na aba Data não é copiada.
    let repair = parseDate(addHours(creation, 1));
    const clockPaused = root.BaixaHelpers.normalizeText(data.paradaRelogio) === "sim";
    const pause = parseDate(data.dataParadaRelogio);
    if (!objective) return { valid: false, reason: "Data Objetivo não identificada ou inválida." };
    if (!repair) return { valid: false, reason: "Não foi possível calcular Data de Reparo + 1 hora." };
    // O SIGITM recusa qualquer data que caia durante a pausa. Quando Criação
    // +1h conflita, usa o último minuto antes do início da pausa.
    if (clockPaused && pause && repair.getTime() >= pause.getTime()) {
      repair = new Date(pause.getTime() - 60 * 1000);
    }
    if (repair.getTime() <= creation.getTime()) return { valid: false, reason: "Data de Reparo deve ser posterior à Data Criação." };
    if (repair.getTime() >= objective.getTime()) return { valid: false, reason: "Data de Reparo deve ser anterior à Data Objetivo." };
    const slaEnd = new Date(creation.getTime() + 4 * 60 * 60 * 1000);
    if (repair.getTime() > slaEnd.getTime()) return { valid: false, reason: "Data de Reparo excede o SLA de 4 horas." };
    if (clockPaused && !pause) return { valid: false, reason: "Pausa de Relógio está ativa, mas a data/hora da pausa não foi identificada." };
    if (clockPaused && pause && repair.getTime() >= pause.getTime()) return { valid: false, reason: "Data de Reparo deve ser anterior à parada de relógio." };
    return { valid: true, repair, repairValue: formatDate(repair), originalRepair, objective, pause, slaEnd };
  }

  const api = { parseDate, addHours, formatDate, repairFromCreation, midpointBetweenDates, validateDates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaDateHandler = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
