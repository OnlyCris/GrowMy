import {
  computeCostMicroUsd,
  fetchWithTimeout,
  isRetryableStatus,
  ProviderError,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type ProviderName,
} from '../provider';

/**
 * ADAPTER PER API COMPATIBILI OPENAI
 *
 * DeepSeek e OpenAI espongono lo stesso identico schema `/chat/completions`:
 * un solo adapter li serve entrambi cambiando base URL, chiave e listino.
 *
 * È il motivo per cui aggiungere DeepSeek è costato zero codice nuovo — e per
 * cui domani un provider self-hosted compatibile (vLLM, Ollama, LM Studio)
 * entrerebbe con una riga di configurazione.
 */

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

export interface OpenAiCompatibleConfig {
  name: ProviderName;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Prezzo in dollari per milione di token in ingresso. */
  pricePerMillionInput: number;
  pricePerMillionOutput: number;
  defaultTemperature?: number;
}

export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleConfig,
): LlmProvider {
  return {
    name: config.name,
    model: config.model,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const timeoutMs = request.timeoutMs ?? 120_000;

      const body: Record<string, unknown> = {
        model: config.model,
        messages: request.messages.map((m: ChatMessage) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: request.temperature ?? config.defaultTemperature ?? 0.7,
      };

      if (request.maxOutputTokens) {
        body.max_tokens = request.maxOutputTokens;
      }
      if (request.jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(body),
          },
          timeoutMs,
        );
      } catch (error) {
        // Timeout o errore di rete: sempre ritentabile, il problema non è
        // nella richiesta ma nel trasporto.
        throw new ProviderError(
          error instanceof Error ? error.message : 'Errore di rete',
          config.name,
          true,
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(
          `HTTP ${response.status}: ${detail.slice(0, 300)}`,
          config.name,
          isRetryableStatus(response.status),
          response.status,
        );
      }

      const data = (await response.json()) as OpenAiChatResponse;

      if (data.error) {
        throw new ProviderError(
          data.error.message ?? 'Errore del provider',
          config.name,
          false,
        );
      }

      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        // Una risposta vuota è quasi sempre un filtro di contenuto o un
        // troncamento: ritentare con lo stesso prompt darebbe lo stesso esito,
        // ma un altro provider potrebbe rispondere.
        throw new ProviderError(
          `Risposta vuota (finish_reason: ${data.choices?.[0]?.finish_reason ?? 'ignoto'})`,
          config.name,
          true,
        );
      }

      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;

      return {
        text,
        provider: config.name,
        model: config.model,
        inputTokens,
        outputTokens,
        costMicroUsd: computeCostMicroUsd(
          inputTokens,
          outputTokens,
          config.pricePerMillionInput,
          config.pricePerMillionOutput,
        ),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * DeepSeek.
 * Prezzi al momento della scrittura (USD per milione di token): 0.27 in
 * ingresso, 1.10 in uscita — circa un decimo dei concorrenti, il motivo per cui
 * è il provider primario di default.
 */
export function createDeepSeekProvider(
  apiKey: string,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'deepseek',
    apiKey,
    baseUrl,
    model,
    pricePerMillionInput: 0.27,
    pricePerMillionOutput: 1.1,
  });
}

/** OpenAI. Prezzi riferiti a gpt-4o-mini. */
export function createOpenAiProvider(
  apiKey: string,
  model = 'gpt-4o-mini',
): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'openai',
    apiKey,
    baseUrl: 'https://api.openai.com',
    model,
    pricePerMillionInput: 0.15,
    pricePerMillionOutput: 0.6,
  });
}

/**
 * OpenRouter. Un solo endpoint davanti a decine di modelli (Anthropic,
 * OpenAI, Google, Meta, ...): stesso schema `/chat/completions` di OpenAI,
 * il modello si sceglie con lo slug `provider/nome` nel campo `model`.
 *
 * Prezzi NON fissi come gli altri adapter: dipendono dal modello scelto via
 * `OPENROUTER_MODEL`, OpenRouter li rifattura quasi 1:1 dal provider a monte.
 * Qui teniamo il listino di gpt-4o-mini (il default) come stima migliore
 * possibile per il conteggio costi — un modello diverso renderà quel numero
 * indicativo, non i token effettivamente fatturati (che comunque OpenRouter
 * non riporta nella risposta di `/chat/completions`).
 */
export function createOpenRouterProvider(
  apiKey: string,
  model = 'openai/gpt-4o-mini',
): LlmProvider {
  return createOpenAiCompatibleProvider({
    name: 'openrouter',
    apiKey,
    baseUrl: 'https://openrouter.ai/api',
    model,
    pricePerMillionInput: 0.15,
    pricePerMillionOutput: 0.6,
  });
}
