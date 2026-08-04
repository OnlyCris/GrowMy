import {
  computeCostMicroUsd,
  fetchWithTimeout,
  isRetryableStatus,
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from '../provider';

/**
 * ADAPTER ANTHROPIC (Claude)
 *
 * Differenze dallo schema OpenAI che questo adapter assorbe:
 *  - il messaggio di sistema è un campo top-level `system`, non un messaggio;
 *  - `max_tokens` è OBBLIGATORIO (l'API rifiuta la richiesta senza);
 *  - l'autenticazione usa l'header `x-api-key`, non `Authorization: Bearer`;
 *  - serve l'header di versione `anthropic-version`.
 */

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export interface AnthropicProviderConfig {
  apiKey: string;
  model?: string;
  pricePerMillionInput?: number;
  pricePerMillionOutput?: number;
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): LlmProvider {
  const model = config.model ?? 'claude-sonnet-5';
  const priceIn = config.pricePerMillionInput ?? 3;
  const priceOut = config.pricePerMillionOutput ?? 15;

  return {
    name: 'anthropic',
    model,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const timeoutMs = request.timeoutMs ?? 120_000;

      const systemMessages = request.messages.filter((m) => m.role === 'system');
      const chatMessages = request.messages.filter((m) => m.role !== 'system');

      const body: Record<string, unknown> = {
        model,
        // Obbligatorio per Anthropic: senza, l'API risponde 400.
        max_tokens: request.maxOutputTokens ?? 8_192,
        temperature: request.temperature ?? 0.7,
        messages: chatMessages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      };

      if (systemMessages.length > 0) {
        body.system = systemMessages.map((m) => m.content).join('\n\n');
      }

      // Anthropic non ha una modalità JSON nativa: si rafforza via prompt.
      // `parseJsonResponse` ripulisce comunque eventuali recinti markdown.
      if (request.jsonMode) {
        body.system = [
          body.system,
          'Rispondi ESCLUSIVAMENTE con JSON valido. Nessun testo prima o dopo, nessun blocco markdown.',
        ]
          .filter(Boolean)
          .join('\n\n');
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(
          'https://api.anthropic.com/v1/messages',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
          },
          timeoutMs,
        );
      } catch (error) {
        throw new ProviderError(
          error instanceof Error ? error.message : 'Errore di rete',
          'anthropic',
          true,
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(
          `HTTP ${response.status}: ${detail.slice(0, 300)}`,
          'anthropic',
          isRetryableStatus(response.status),
          response.status,
        );
      }

      const data = (await response.json()) as AnthropicResponse;

      if (data.error) {
        throw new ProviderError(
          data.error.message ?? 'Errore del provider',
          'anthropic',
          false,
        );
      }

      const text =
        data.content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('') ?? '';

      if (!text.trim()) {
        throw new ProviderError(
          `Risposta vuota (stop_reason: ${data.stop_reason ?? 'ignoto'})`,
          'anthropic',
          true,
        );
      }

      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;

      return {
        text,
        provider: 'anthropic',
        model,
        inputTokens,
        outputTokens,
        costMicroUsd: computeCostMicroUsd(
          inputTokens,
          outputTokens,
          priceIn,
          priceOut,
        ),
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
