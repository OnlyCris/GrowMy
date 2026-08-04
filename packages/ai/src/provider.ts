/**
 * INTERFACCIA COMUNE DEI PROVIDER LLM
 *
 * Un solo contratto per Gemini, DeepSeek, Anthropic e OpenAI. Il resto del
 * codice non sa quale provider sta usando: chiede testo, riceve testo e un
 * conteggio di token.
 *
 * Perché non usare gli SDK ufficiali: quattro SDK significano quattro
 * dipendenze pesanti, quattro modelli di errore diversi e quattro cicli di
 * aggiornamento. Le API sono tutte REST su JSON — `fetch` basta, e ci lascia il
 * controllo su timeout, retry e conteggio dei costi.
 */

export type ProviderName = 'google' | 'deepseek' | 'anthropic' | 'openai';

/** Messaggio in formato neutro, tradotto da ogni adapter nel proprio schema. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** 0 = deterministico, 1 = creativo. Default per provider se omesso. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Chiede al modello di rispondere con JSON valido. Non tutti i provider lo
   * garantiscono a livello di API: gli adapter che non lo supportano lo
   * rafforzano via prompt, e `parseJsonResponse` ripulisce comunque l'output.
   */
  jsonMode?: boolean;
  /** Interrompe la richiesta oltre questa soglia. Default 120s. */
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Costo in micro-dollari (interi). Mai float sul denaro: 0.1 + 0.2 non fa
   * 0.3 in virgola mobile, e questi valori si sommano in `usage_counters`.
   */
  costMicroUsd: number;
  durationMs: number;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Errore di provider con la distinzione che conta per il router:
 * `retryable` significa "riprova, magari con un altro provider";
 * non-retryable significa "il problema è nella richiesta, cambiare provider
 * non serve" — per esempio un prompt che viola le policy di contenuto.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Classifica un codice HTTP.
 *
 * 429 e 5xx sono transitori: ha senso ritentare o passare al provider
 * successivo. 400 e 401 no — una chiave sbagliata resta sbagliata, e
 * riprovare brucia solo tempo.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * `fetch` con timeout reale.
 *
 * `fetch` da solo non ha timeout: una richiesta appesa resterebbe tale finché
 * il worker non viene ucciso, tenendo occupato uno slot di concorrenza per
 * sempre. `AbortController` è l'unico modo di garantirne la fine.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timeout dopo ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Estrae JSON da una risposta LLM.
 *
 * I modelli avvolgono spesso il JSON in un blocco markdown ```json, o
 * aggiungono una frase di cortesia prima e dopo. Questa funzione tollera
 * entrambe le cose: cerca il primo `{` o `[` e l'ultimo corrispondente.
 *
 * Necessaria anche con `jsonMode`: non tutti i provider lo rispettano davvero.
 */
export function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();

  // Rimuove il recinto markdown, con o senza etichetta di linguaggio.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  // Isola il primo oggetto o array completo.
  const firstBrace = text.search(/[[{]/);
  if (firstBrace > 0) text = text.slice(firstBrace);

  const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (lastBrace >= 0 && lastBrace < text.length - 1) {
    text = text.slice(0, lastBrace + 1);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `La risposta del modello non è JSON valido. Inizio: ${raw.slice(0, 200)}`,
    );
  }
}

/**
 * Calcola il costo in micro-dollari.
 * I prezzi sono per milione di token; li teniamo in un solo posto per provider
 * così l'aggiornamento di un listino è una riga sola.
 */
export function computeCostMicroUsd(
  inputTokens: number,
  outputTokens: number,
  pricePerMillionInput: number,
  pricePerMillionOutput: number,
): number {
  const inputCost = (inputTokens / 1_000_000) * pricePerMillionInput;
  const outputCost = (outputTokens / 1_000_000) * pricePerMillionOutput;
  return Math.round((inputCost + outputCost) * 1_000_000);
}

/**
 * Stima grezza dei token quando il provider non li riporta.
 * ~4 caratteri per token è l'approssimazione standard per l'inglese; per
 * l'italiano è leggermente pessimistica, il che va bene per una stima di costo.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
