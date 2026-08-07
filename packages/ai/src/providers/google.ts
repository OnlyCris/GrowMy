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
 *
 * ROTAZIONE CHIAVE × MODELLO
 *
 * Il piano gratuito di AI Studio limita la quota per singola combinazione
 * chiave+modello, non per account: due chiavi diverse (anche dello stesso
 * account) o due modelli diversi con la STESSA chiave hanno bucket di quota
 * indipendenti — verificato in produzione (una chiave a quota esaurita su
 * `gemini-2.0-flash` rispondeva 200 su `gemini-flash-latest` senza cambiare
 * nulla d'altro). Ogni chiamata prova lo slot successivo in rotazione; solo
 * se TUTTI gli slot falliscono con un errore transitorio la chiamata fallisce
 * davvero — il router sopra non vede quasi mai un 429, perché è già stato
 * assorbito qui.
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
  /** Una o più chiavi AI Studio: bucket di quota indipendenti, in rotazione. */
  apiKeys: string[];
  /** Uno o più modelli: bucket di quota indipendenti anche a parità di chiave. */
  models?: string[];
  pricePerMillionInput?: number;
  pricePerMillionOutput?: number;
}

async function callGemini(
  request: CompletionRequest,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<GeminiResponse> {
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
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: systemMessages.map((m) => ({ text: m.content })),
    };
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
    throw new ProviderError(data.error.message ?? 'Errore del provider', 'google', false);
  }
  return data;
}

export function createGoogleProvider(config: GoogleProviderConfig): LlmProvider {
  const apiKeys = config.apiKeys;
  if (apiKeys.length === 0) {
    throw new Error('createGoogleProvider richiede almeno una API key.');
  }

  // `-latest` invece di una versione fissata: `gemini-2.0-flash` è stato
  // ritirato per i nuovi progetti (404 "no longer available to new users")
  // mentre l'alias restava servibile — scoperto in produzione confrontando le
  // risposte reali dell'API per la chiave in uso.
  const models = config.models?.length ? config.models : ['gemini-flash-latest'];
  const priceIn = config.pricePerMillionInput ?? 0.1;
  const priceOut = config.pricePerMillionOutput ?? 0.4;

  const totalSlots = apiKeys.length * models.length;
  // Cursore condiviso fra tutte le chiamate di questa istanza: avanza a ogni
  // tentativo, riuscito o no, così le richieste successive si spalmano su
  // slot diversi invece di martellare sempre lo stesso.
  let cursor = 0;

  return {
    name: 'google',
    model: models[0],

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const startedAt = Date.now();
      const timeoutMs = request.timeoutMs ?? 120_000;

      let lastError: unknown;

      for (let attempt = 0; attempt < totalSlots; attempt++) {
        const slot = cursor % totalSlots;
        cursor += 1;
        const apiKey = apiKeys[slot % apiKeys.length];
        const model = models[Math.floor(slot / apiKeys.length) % models.length];

        try {
          const data = await callGemini(request, apiKey, model, timeoutMs);

          const candidate = data.candidates?.[0];
          const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

          if (!text.trim()) {
            // `SAFETY` indica un blocco dei filtri di contenuto: ritentare con
            // lo stesso prompt è inutile, ma un altro slot può rispondere.
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
            costMicroUsd: computeCostMicroUsd(inputTokens, outputTokens, priceIn, priceOut),
            durationMs: Date.now() - startedAt,
          };
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ProviderError ? error.retryable : true;
          // Errore non transitorio (prompt rifiutato, chiave non valida come
          // formato): cambiare slot non risolverebbe nulla di sistematico, ma
          // potrebbe comunque essere una chiave diversa e valida — prosegue
          // comunque alla rotazione successiva, si ferma solo a slot esauriti.
          if (!retryable && attempt === totalSlots - 1) break;
        }
      }

      throw lastError instanceof Error ? lastError : new Error('Richiesta Gemini fallita.');
    },
  };
}
