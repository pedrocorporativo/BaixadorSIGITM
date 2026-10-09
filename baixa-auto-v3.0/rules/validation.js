(function (root) {
  "use strict";

  function compareAIWithRules(ai, deterministic, minimumConfidence = 0.85) {
    if (!deterministic?.allowed) return { allowed: false, status: "BLOQUEADO", reason: deterministic?.motivo || "Regra não identificada." };
    if (!ai || ai.available === false) {
      return {
        allowed: true,
        status: "FALLBACK DETERMINÍSTICO",
        reason: ai?.reason || "IA indisponível; decisão obtida somente pelo motor determinístico.",
        confidence: null,
        provider: "Motor determinístico"
      };
    }
    const verdict = ai.decision;
    if (!verdict || verdict.podeExecutar !== true || verdict.codigoBaixa !== deterministic.codigoBaixa || verdict.diagnostico !== deterministic.diagnostico) {
      return {
        allowed: false,
        status: "DIVERGÊNCIA IA × REGRAS",
        reason: "Divergência entre IA e regras do sistema. Baixa bloqueada para segurança.",
        confidence: verdict?.confianca ?? null,
        provider: ai.provider || "IA"
      };
    }
    const expectedFields = deterministic.normalizedFields || {};
    const aiFields = verdict.normalizedFields || {};
    const fieldMismatch = Object.keys(expectedFields).some(key => key === "intragov"
      ? aiFields[key] !== expectedFields[key]
      : root.BaixaHelpers.normalizeText(aiFields[key]) !== root.BaixaHelpers.normalizeText(expectedFields[key]));
    if (fieldMismatch) {
      return {
        allowed: false,
        status: "DIVERGÊNCIA IA × REGRAS",
        reason: "A interpretação de campos da IA diverge dos valores normalizados localmente. Baixa bloqueada para segurança.",
        confidence: verdict.confianca,
        provider: ai.provider || "IA"
      };
    }
    if (verdict.confianca < minimumConfidence) {
      return { allowed: false, status: "BLOQUEADO", reason: "Confiança da IA abaixo do limite configurado.", confidence: verdict.confianca, provider: ai.provider };
    }
    return { allowed: true, status: "VALIDADO IA × REGRAS", reason: verdict.motivo, confidence: verdict.confianca, provider: ai.provider };
  }

  const api = { compareAIWithRules };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaValidation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
