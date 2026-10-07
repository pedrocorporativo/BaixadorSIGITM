(function (root) {
  "use strict";

  async function analyzeCase(input, settings, signal) {
    const payload = root.BaixaHelpers.buildAIPayload(input);
    const required = ["tipoAbertura", "procedencia", "tipoIncidencia"];
    const missing = required.filter(key => !String(payload[key] || "").trim());
    if (missing.length) return { available: false, reason: `Campos ausentes; IA não consultada: ${missing.join(", ")}.`, payload };
    if (payload.intragov === null || !payload.servicoAfetado) {
      return { available: false, reason: "Intragov ou Serviço Afetado não identificado; usando as regras determinísticas locais.", payload };
    }
    if (!settings?.apiKey) return { available: false, reason: "IA não configurada; usando somente as regras determinísticas.", payload };

    try {
      const raw = await root.BaixaAIProvider.request({
        provider: settings.provider || "gemini",
        apiKey: settings.apiKey,
        model: settings.model || "gemini-3.8-flash",
        temperature: Number(settings.temperature ?? 0),
        payload,
        signal
      });
      const decision = root.BaixaAISchema.validateDecision(raw);
      return { available: true, provider: settings.provider || "Gemini API", decision, payload };
    } catch (error) {
      return {
        available: false,
        reason: `IA indisponível: ${error.message} A decisão será avaliada pelo motor determinístico local.`,
        payload
      };
    }
  }

  const api = { analyzeCase };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAIService = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
