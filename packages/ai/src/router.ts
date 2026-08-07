import type { Logger } from '@growmy/logger';

import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type ProviderName,
} from './provider';
import { createAnthropicProvider } from './providers/anthropic';
import { createGoogleProvider } from './providers/google';
import {
  createDeepSeekProvider,
  createOpenAiProvider,
  createOpenRouterProvider,
} from './providers/openai-compatible';

/**
 * ROUTER MULTI-PROVIDER
 *
 * Prova i provider nell'ordine configurato. Se uno fallisce in modo
 * ritentabile — rate limit, 5xx, timeout — passa al successivo invece di far
 * fallire il job.
 *
 * Perché conta: una generazione dura minuti e sta dentro un job che ha già
 * riservato un credito. Far fallire l'intera pipeline perché DeepSeek ha
 * risposto 429 per tre secondi significa bruciare quel credito e mandare
 * l'articolo in dead-letter per un problema transitorio.
 *
 * Un errore NON ritentabile (chiave invalida, prompt rifiutato dai filtri)
 * interrompe subito la catena per quel provider ma prova comunque il
 * successivo: una chiave scaduta su DeepSeek non deve impedire a Gemini di
 * lavorare.
 */

export interface RouterConfig {
  order: ProviderName[];
  /** Più chiavi/modelli: il provider Google ruota fra tutte le combinazioni. */
  google?: { apiKeys: string[]; models?: string[] };
  deepseek?: { apiKey: string; baseUrl?: string; model?: string };
  anthropic?: { apiKey: string; model?: string };
  openai?: { apiKey: string; model?: string };
  openrouter?: { apiKey: string; model?: string };
  logger?: Logger;
  /** Tentativi per singolo provider prima di passare al successivo. */
  attemptsPerProvider?: number;
}

export interface LlmRouter {
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /** Provider effettivamente disponibili, nell'ordine di tentativo. */
  readonly availableProviders: ProviderName[];
}

/** Backoff esponenziale con jitter, per non sincronizzare i retry concorrenti. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(1_000 * 2 ** attempt, 15_000);
  return base + Math.random() * 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlmRouter(config: RouterConfig): LlmRouter {
  const providers = new Map<ProviderName, LlmProvider>();

  if (config.google?.apiKeys.length) {
    providers.set(
      'google',
      createGoogleProvider({
        apiKeys: config.google.apiKeys,
        models: config.google.models,
      }),
    );
  }
  if (config.deepseek?.apiKey) {
    providers.set(
      'deepseek',
      createDeepSeekProvider(
        config.deepseek.apiKey,
        config.deepseek.baseUrl,
        config.deepseek.model,
      ),
    );
  }
  if (config.anthropic?.apiKey) {
    providers.set(
      'anthropic',
      createAnthropicProvider({
        apiKey: config.anthropic.apiKey,
        model: config.anthropic.model,
      }),
    );
  }
  if (config.openai?.apiKey) {
    providers.set(
      'openai',
      createOpenAiProvider(config.openai.apiKey, config.openai.model),
    );
  }
  if (config.openrouter?.apiKey) {
    providers.set(
      'openrouter',
      createOpenRouterProvider(config.openrouter.apiKey, config.openrouter.model),
    );
  }

  // L'ordine richiesto, filtrato su ciò che è davvero configurato: evita di
  // sprecare un tentativo su un provider senza chiave.
  const chain = config.order.filter((name) => providers.has(name));

  if (chain.length === 0) {
    throw new Error(
      'Nessun provider LLM configurato. Serve almeno una chiave API valida.',
    );
  }

  const attemptsPerProvider = config.attemptsPerProvider ?? 2;
  const log = config.logger;

  return {
    availableProviders: chain,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      const failures: string[] = [];

      for (const name of chain) {
        const provider = providers.get(name)!;

        for (let attempt = 0; attempt < attemptsPerProvider; attempt++) {
          try {
            const result = await provider.complete(request);

            log?.debug(
              {
                provider: name,
                model: result.model,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costMicroUsd: result.costMicroUsd,
                durationMs: result.durationMs,
                attempt,
              },
              'completamento riuscito',
            );

            return result;
          } catch (error) {
            const isProviderError = error instanceof ProviderError;
            const retryable = isProviderError ? error.retryable : true;
            const message =
              error instanceof Error ? error.message : String(error);

            failures.push(`${name}: ${message}`);

            log?.warn(
              { provider: name, attempt, retryable, err: message },
              'tentativo fallito',
            );

            // Errore definitivo per QUESTO provider: inutile insistere, ma il
            // provider successivo può funzionare.
            if (!retryable) break;

            // Ultimo tentativo su questo provider: passa al successivo senza
            // aspettare inutilmente.
            if (attempt === attemptsPerProvider - 1) break;

            await sleep(backoffDelayMs(attempt));
          }
        }
      }

      throw new Error(
        `Tutti i provider hanno fallito.\n${failures.map((f) => `  - ${f}`).join('\n')}`,
      );
    },
  };
}

/**
 * Costruisce il router leggendo direttamente le variabili d'ambiente.
 * È il costruttore usato dal worker: tiene la configurazione in un solo posto.
 */
export function createLlmRouterFromEnv(logger?: Logger): LlmRouter {
  const rawOrder =
    process.env.LLM_PROVIDER_ORDER ?? 'openrouter,google,deepseek,anthropic';

  const order = rawOrder
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is ProviderName =>
      ['google', 'deepseek', 'anthropic', 'openai', 'openrouter'].includes(name),
    );

  // Più chiavi/modelli separati da virgola: bucket di quota indipendenti,
  // vedi il commento in `providers/google.ts` su perché conta.
  const googleApiKeys = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const googleModels = (process.env.GOOGLE_GENERATIVE_AI_MODELS ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  return createLlmRouter({
    order,
    logger,
    google: googleApiKeys.length
      ? { apiKeys: googleApiKeys, models: googleModels.length ? googleModels : undefined }
      : undefined,
    deepseek: process.env.DEEPSEEK_API_KEY
      ? {
          apiKey: process.env.DEEPSEEK_API_KEY,
          baseUrl: process.env.DEEPSEEK_BASE_URL,
        }
      : undefined,
    anthropic: process.env.ANTHROPIC_API_KEY
      ? { apiKey: process.env.ANTHROPIC_API_KEY }
      : undefined,
    openai: process.env.OPENAI_API_KEY
      ? { apiKey: process.env.OPENAI_API_KEY }
      : undefined,
    openrouter: process.env.OPENROUTER_API_KEY
      ? {
          apiKey: process.env.OPENROUTER_API_KEY,
          model: process.env.OPENROUTER_MODEL,
        }
      : undefined,
  });
}
