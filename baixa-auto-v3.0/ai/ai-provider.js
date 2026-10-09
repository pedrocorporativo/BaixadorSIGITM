(function (root) {
  "use strict";

  const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
  const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
  const CLASSIFICATION_INSTRUCTIONS = [
    "Sua única tarefa é classificar os campos do chamado e retornar o código e diagnóstico no JSON. Você não controla o navegador, não clica em abas, botões, popups ou lupa; a extensão executa a sequência de interface separadamente.",
    "Classifique os campos de chamados usando EXCLUSIVAMENTE as regras fechadas abaixo.",
    "Não invente valores, campos, códigos nem combinações; não complete dados vazios.",
    "Normalize Intragov como verdadeiro apenas quando estiver marcado/Sim; essa informação também é usada pela automação local para aplicar o preenchimento de telefones. Intragov/Serviço ausentes não impedem combinações que já determinam o código.",
    "Prioridade: cliente SEDUC ou FED => 2A011, independente dos demais campos e sem perguntar ao usuário. Considere SEDUC quando o cliente contém SECRETARIA e EDUCAÇÃO/EDUCACAO, inclusive nomes como SAO PAULO SECRETARIA DA EDUCACAO, ou a sigla SEDUC. Considere FED quando o cliente contém FUNDO ou FUNDAÇÃO/FUNDACAO, DESENVOLVIMENTO e EDUCAÇÃO/EDUCACAO, ou a sigla FED. Para os demais clientes: 1) Tipo de Incidência DDR => 57033, independente dos demais campos; 2) Intragov true => 6Y200, independente do serviço e dos demais campos; 3) REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + PROATIVO => 2A082; 4) INICIAL + PREVENTIVO/REATIVO/PROATIVO ou REPETIDA, REPETIDA 7 DIAS ou REPETIDA 30 DIAS + REATIVO => 2A011. Durante a baixa automática, a extensão pergunta ao usuário somente quando nenhuma regra nem escolha já aprendida identificar o código; escolhas anteriores iguais são reutilizadas.",
    "Diagnóstico: use 00000032 Testado OK quando Tipo de Incidência for DDR; nos demais casos use 00000017 Testado OK. A regra do diagnóstico depende somente da incidência e vale mesmo quando o código de baixa for definido pela prioridade do cliente.",
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

  // O schema interno usa tipos em maiúsculas (OBJECT/STRING); o campo
  // responseFormat.text.schema da API atual espera JSON Schema em minúsculas.
  function toJsonSchema(node) {
    if (Array.isArray(node)) return node.map(toJsonSchema);
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [
      key,
      key === "type" && typeof value === "string" ? value.toLowerCase() : toJsonSchema(value)
    ]));
  }

  function networkError(error, host) {
    if (error?.name === "AbortError") return error;
    return new Error(`Sem conexão com ${host}. Verifique a internet e se a rede/proxy/firewall da empresa libera esse endereço. (${error?.message || "falha de rede"})`);
  }

  function httpError(label, status, message, model) {
    const raw = String(message || "").replace(/\s+/g, " ").slice(0, 220);
    let hint = "";
    if (status === 401 || status === 403 || /api key not valid|api_key_invalid|invalid api key/i.test(raw)) hint = "Chave recusada: confira se a API Key está correta e ativa.";
    else if (status === 404) hint = `Modelo '${model}' não encontrado: troque o modelo nas configurações.`;
    else if (status === 429) hint = "Limite de uso do provedor atingido (por minuto ou por dia). Aguarde ou troque de provedor/modelo.";
    else if (status >= 500) hint = "O provedor está instável no momento; tente novamente.";
    return new Error(`${label} (HTTP ${status}): ${hint ? `${hint} ` : ""}${raw}`.trim());
  }

  async function postGemini(url, apiKey, body, signal) {
    const requestControl = abortableSignal(signal);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: requestControl.signal
      });
    } catch (error) {
      requestControl.cleanup();
      throw networkError(error, "generativelanguage.googleapis.com");
    }
    // O tempo limite também cobre a leitura do corpo da resposta.
    const data = await response.json().catch(() => ({})).finally(requestControl.cleanup);
    return { response, data };
  }

  async function requestGemini({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Gemini não configurada.");
    const selectedModel = String(model || root.BaixaHelpers.DEFAULT_MODELS.gemini).trim();
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(selectedModel)) throw new Error("Modelo Gemini inválido.");
    const url = `${GEMINI_BASE}${encodeURIComponent(selectedModel)}:generateContent`;
    const schema = toJsonSchema(root.BaixaAISchema.outputSchema);
    const base = {
      systemInstruction: { parts: [{ text: CLASSIFICATION_INSTRUCTIONS }] },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(payload) }] }]
    };
    // Modelos com raciocínio gastam parte do limite de saída "pensando"; 500 tokens
    // podiam esgotar antes do JSON. Por isso o limite é folgado.
    const attempts = [
      { ...base, generationConfig: { temperature: Number(temperature), maxOutputTokens: 2048, responseFormat: { text: { mimeType: "application/json", schema } } } },
      { ...base, generationConfig: { temperature: Number(temperature), maxOutputTokens: 2048, responseMimeType: "application/json", responseJsonSchema: schema } }
    ];
    let result;
    for (let index = 0; index < attempts.length; index++) {
      result = await postGemini(url, apiKey, attempts[index], signal);
      if (result.response.ok) break;
      const message = result.data.error?.message || "";
      // Se a API recusar o formato do pedido (campo desconhecido), tenta o formato clássico.
      const formatRejected = result.response.status === 400 && /unknown name|invalid json payload|cannot find field|unrecognized|responseFormat|responseJsonSchema|response_format/i.test(message);
      if (!formatRejected) break;
    }
    const { response, data: body } = result;
    if (!response.ok) throw httpError("Gemini API", response.status, body.error?.message, selectedModel);
    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || "").join("").trim();
    if (!text) {
      const reason = candidate?.finishReason || body.promptFeedback?.blockReason || "sem motivo informado";
      throw new Error(`Gemini não retornou conteúdo estruturado (motivo: ${reason}).`);
    }
    return parseJsonObject(text, "Gemini");
  }

  async function requestGroq({ apiKey, model, temperature, payload, signal }) {
    if (!apiKey) throw new Error("API Key do Groq não configurada.");
    const selectedModel = String(model || root.BaixaHelpers.DEFAULT_MODELS.groq).trim();
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
          max_completion_tokens: 2000,
          ...(/gpt-oss/i.test(selectedModel) ? { reasoning_effort: "low" } : {}),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `${CLASSIFICATION_INSTRUCTIONS} O objeto deve conter codigoBaixa, diagnostico, motivo, confianca (0 a 1), podeExecutar e normalizedFields com os seis campos originais normalizados. Não inclua texto fora do JSON.` },
            { role: "user", content: `Classifique estes campos e responda somente com json válido: ${JSON.stringify(payload)}` }
          ]
        }),
        signal: requestControl.signal
      });
    } catch (error) {
      requestControl.cleanup();
      throw networkError(error, "api.groq.com");
    }
    const body = await response.json().catch(() => ({})).finally(requestControl.cleanup);
    if (!response.ok) {
      if (body.error?.code === "json_validate_failed" || /failed to generate json/i.test(body.error?.message || "")) {
        throw new Error("Groq não conseguiu gerar uma resposta JSON válida neste modelo. Nenhuma decisão da IA foi aceita; tente novamente ou use o motor determinístico.");
      }
      throw httpError("Groq API", response.status, body.error?.message, selectedModel);
    }
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`Groq retornou resposta vazia (finish_reason: ${body.choices?.[0]?.finish_reason || "desconhecido"}).`);
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
    toJsonSchema,
    defaults: root.BaixaHelpers.DEFAULT_MODELS,
    registerProvider(name, adapter) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(name) || typeof adapter !== "function") throw new Error("Adaptador inválido.");
      adapters.set(name, adapter);
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BaixaAIProvider = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
