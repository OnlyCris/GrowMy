/**
 * @growmy/ai — layer di astrazione sui provider LLM.
 *
 * Nessun'altra parte del codice importa un SDK di provider o conosce l'URL di
 * un'API: si passa sempre da `LlmRouter`, che gestisce fallback, retry e
 * conteggio dei costi.
 */

export * from './provider';
export * from './router';
export * from './guardrails';
export * from './prompts/index';

export { createGoogleProvider } from './providers/google';
export { createAnthropicProvider } from './providers/anthropic';
export {
  createDeepSeekProvider,
  createOpenAiProvider,
  createOpenAiCompatibleProvider,
} from './providers/openai-compatible';
