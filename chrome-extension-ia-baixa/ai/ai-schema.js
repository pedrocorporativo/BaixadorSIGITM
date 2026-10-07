(function (root) {
  "use strict";

  const codes = ["", "57033", "6Y200", "2A082", "2A011"];
  const diagnoses = ["", "00000017 Testado OK"];
  const openings = ["", "INICIAL", "REPETIDA 7 DIAS", "REPETIDA 30 DIAS"];
  const procedures = ["", "PROATIVO", "REATIVO", "PREVENTIVO"];
  const incidences = ["", "DADOS", "CONVERGENTE", "DDR"];
  const outputSchema = Object.freeze({
    type: "OBJECT",
    additionalProperties: false,
    properties: {
      codigoBaixa: { type: "STRING", enum: codes },
      diagnostico: { type: "STRING", enum: diagnoses },
      motivo: { type: "STRING" },
      confianca: { type: "NUMBER" },
      podeExecutar: { type: "BOOLEAN" },
      normalizedFields: {
        type: "OBJECT",
        additionalProperties: false,
        properties: {
          tipoAbertura: { type: "STRING", enum: openings },
          procedencia: { type: "STRING", enum: procedures },
          tipoIncidencia: { type: "STRING", enum: incidences },
          cliente: { type: "STRING" },
          intragov: { type: "BOOLEAN" },
          servicoAfetado: { type: "STRING" }
        },
        required: ["tipoAbertura", "procedencia", "tipoIncidencia", "cliente", "intragov", "servicoAfetado"]
      }
    },
    required: ["codigoBaixa", "diagnostico", "motivo", "confianca", "podeExecutar", "normalizedFields"]
  });

  function validateDecision(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resposta da IA não é um objeto JSON.");
    if (!codes.includes(value.codigoBaixa) || !diagnoses.includes(value.diagnostico)) throw new Error("Código ou diagnóstico fora da lista permitida.");
    if (typeof value.motivo !== "string" || value.motivo.length > 300) throw new Error("Motivo inválido.");
    if (typeof value.confianca !== "number" || !Number.isFinite(value.confianca) || value.confianca < 0 || value.confianca > 1) throw new Error("Confiança inválida.");
    if (typeof value.podeExecutar !== "boolean") throw new Error("Campo podeExecutar inválido.");
    const fields = value.normalizedFields;
    if (!fields || !openings.includes(fields.tipoAbertura) || !procedures.includes(fields.procedencia) || !incidences.includes(fields.tipoIncidencia) ||
      typeof fields.cliente !== "string" || typeof fields.intragov !== "boolean" || typeof fields.servicoAfetado !== "string") {
      throw new Error("Campos normalizados pela IA fora do schema permitido.");
    }
    return {
      codigoBaixa: value.codigoBaixa,
      diagnostico: value.diagnostico,
      motivo: value.motivo,
      confianca: value.confianca,
      podeExecutar: value.podeExecutar,
      normalizedFields: fields
    };
  }

  const api = { outputSchema, validateDecision };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAISchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
