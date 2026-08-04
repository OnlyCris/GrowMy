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
 * ADAPTER GOOGLE GEMINI
 *
 * L'API Gemini ha uno schema tutto suo, diverso da quello OpenAI:
 *  - i messaggi si chiamano `contents` e i ruoli sono `user` / `model`;
 *  - il messaggio di sistema è un campo separato (`systemInstruction`), non un
 *    messaggio con ruolo `system`;
 *  - la chiave va in query string, non in un header.
 *
 * Tradurre qui significa che il resto del codice non deve sapere nulla di tutto
 * questo.
 */

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; status?: string };
}

export interface GoogleProviderConfig {
  apiKey: string;
  model?: string;
  pricePerMillionInput?: number;
  pricePerMillionOutput?: number;
}

export function createGoogleProvider(
  config: GoogleProviderConfig,
): LlmProvider {
  const model = config.model ?? 'gemini-2.0-flash';
  // Prezzi di gemini-2.0-flash al momento della scrittura.
  const priceIn = config.pricePerMillionInput ?? 0.1;
  const priceOut = config.pricePerMillionOutput ?? 0.4;

  return {
    name: 'google',
    model,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const timeoutMs = request.timeoutMs ?? 120_000;

      // Gemini separa l'istruzione di sistema dal resto della conversazione.
      const systemMessages = request.messages.filter((m) => m.role === 'system');
      const chatMessages = request.messages.filter((m) => m.role !== 'system');

      const body: Record<string, unknown> = {
        contents: chatMessages.map((m) => ({
          // Gemini usa `model` dove gli altri usano `assistant`.
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          ...(request.maxOutputTokens
            ? { maxOutputTokens: request.maxOutputTokens }
            : {}),
          ...(request.jsonMode
            ? { responseMimeType: 'application/json' }
            : {}),
        },
      };

      if (systemMessages.length > 0) {
        body.systemInstruction = {
          parts: systemMessages.map((m) => ({ text: m.content })),
        };
      }

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;

      let response: Response;
      try {
        response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          timeoutMs,
        );
      } catch (error) {
        throw new ProviderError(
          error instanceof Error ? error.message : 'Errore di rete',
          'google',
          true,
        );
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ProviderError(
          `HTTP ${response.status}: ${detail.slice(0, 300)}`,
          'google',
          isRetryableStatus(response.status),
          response.status,
        );
      }

      const data = (await response.json()) as GeminiResponse;

      if (data.error) {
        throw new ProviderError(
          data.error.message ?? 'Errore del provider',
          'google',
          false,
        );
      }

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

      if (!text.trim()) {
        // `SAFETY` indica un blocco dei filtri di contenuto: ritentare con lo
        // stesso prompt è inutile, ma un altro provider può rispondere.
        const reason = candidate?.finishReason ?? 'ignoto';
        throw new ProviderError(
          `Risposta vuota (finishReason: ${reason})`,
          'google',
          reason !== 'SAFETY',
        );
      }

      const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        text,
        provider: 'google',
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
