(function (root) {
  "use strict";

  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
  const CLASSIFICATION_INSTRUCTIONS = [
    "Sua única tarefa é classificar os campos do chamado e retornar o código e diagnóstico no JSON. Você não controla o navegador, não clica em abas, botões, popups ou lupa; a extensão executa a sequência de interface separadamente.",
    "Classifique os campos de chamados usando EXCLUSIVAMENTE as regras fechadas abaixo.",
    "Não invente valores, campos, códigos nem combinações; não complete dados vazios.",
    "Normalize Intragov como verdadeiro apenas quando estiver marcado/Sim; essa informação também é usada pela automação local para aplicar o preenchimento de telefones. Intragov/Serviço ausentes não impedem combinações que já determinam o código.",
    "Prioridade: cliente contendo SECRETARIA DE EDUCAÇÃO ou FUNDO PARA O DESENVOLVIMENTO DA EDUCAÇÃO (incluindo nomes com prefixos como SEDUC - e FED -) => 2A011, independente de todos os outros campos e sem perguntar ao usuário. Para outros clientes, o nome não é critério: 1) Tipo de Incidência DDR => 57033; 2) Intragov true + serviço SAI - Serviço de Acesso à Internet => 6Y200; 3) REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + PROATIVO => 2A082; 4) INICIAL + PREVENTIVO/REATIVO/PROATIVO ou REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + REATIVO => 2A011. Durante a baixa automática, a extensão confirma o código com o usuário para cada combinação ainda não aprendida; escolhas anteriores iguais são reutilizadas.",
    "Diagnóstico: use sempre 00000017 Testado OK, inclusive para o serviço SAI.",
    "Retorne somente um objeto json válido conforme o schema. A palavra json neste pedido indica o formato obrigatório da resposta. Use exatamente as chaves e os tipos definidos; não inclua markdown, cercas de código nem texto antes ou depois do objeto. Confiança deve ser entre 0 e 1. Repita campos ausentes sem inventar valores."
  ].join(" ");

  function abortableSignal(signal, timeoutMs = 25000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const stop = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", stop, { once: true });
    return {
      signal: controller.signal,
      cleanup() {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", stop);
      }
    };
  }

  function parseJsonObject(text, label) {
    if (!text) throw new Error(`${label} não retornou JSON.`);
    try { return JSON.parse(text); }
    catch { throw new Error(`${label} retornou JSON inválido.`); }
  }

  async function requestGemini({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Gemini não configurada.");
    const selectedModel = String(model || "gemini-3.8-flash").trim();
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(selectedModel)) throw new Error("Modelo Gemini inválido.");
    const url = `${GEMINI_BASE}${encodeURIComponent(selectedModel)}:generateContent`;
    const systemInstruction = CLASSIFICATION_INSTRUCTIONS;
    const requestControl = abortableSignal(signal);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }],
          generationConfig: {
            temperature: Number(temperature),
            maxOutputTokens: 500,
            responseFormat: {
              text: {
                mimeType: "APPLICATION_JSON",
                schema: root.BaixaAISchema.outputSchema
              }
            }
          }
        }),
        signal: requestControl.signal
      });
    } finally {
      requestControl.cleanup();
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Gemini API retornou HTTP ${response.status}.`);
    const text = body.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini não retornou conteúdo estruturado.");
    return JSON.parse(text);
  }

  async function requestGroq({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Groq não configurada.");
    const selectedModel = String(model || "openai/gpt-oss-120b").trim();
    if (!/^[a-zA-Z0-9._/-]{3,100}$/.test(selectedModel)) throw new Error("Modelo Groq inválido.");
    const requestControl = abortableSignal(signal);
    let response;
    try {
      response = await fetch(GROQ_CHAT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: selectedModel,
          temperature: Number(temperature),
          max_completion_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${CLASSIFICATION_INSTRUCTIONS} O objeto deve conter codigoBaixa, diagnostico, motivo, confianca (0 a 1), podeExecutar e normalizedFields com os seis campos originais normalizados. Não inclua texto fora do JSON.` },
            { role: "user", content: `Classifique estes campos e responda somente com json válido: ${JSON.stringify(payload)}` }
          ]
        }),
        signal: requestControl.signal
      });
    } finally {
      requestControl.cleanup();
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (body.error?.code === "json_validate_failed" || /failed to generate json/i.test(body.error?.message || "")) {
        throw new Error("Groq não conseguiu gerar uma resposta JSON válida neste modelo. Nenhuma decisão da IA foi aceita; tente novamente ou use o motor determinístico.");
      }
      throw new Error(body.error?.message || `Groq API retornou HTTP ${response.status}.`);
    }
    const text = body.choices?.[0]?.message?.content?.trim();
    return parseJsonObject(text, "Groq");
  }

  const adapters = new Map([["gemini", requestGemini], ["groq", requestGroq]]);
  const api = {
    request(providerOptions) {
      const adapter = adapters.get(providerOptions.provider);
      if (!adapter) throw new Error("Provedor não instalado neste adaptador.");
      return adapter(providerOptions);
    },
    providers: [...adapters.keys()],
    defaults: Object.freeze({ gemini: "gemini-3.8-flash", groq: "openai/gpt-oss-120b" }),
    registerProvider(name, adapter) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(name) || typeof adapter !== "function") throw new Error("Adaptador inválido.");
      adapters.set(name, adapter);
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAIProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
