import {
  PublishError,
  type CmsAdapter,
  type IntegrationProvider,
} from './adapter';
import { createGhostAdapter, type GhostCredentials } from './providers/ghost';
import {
  createWebhookAdapter,
  type WebhookCredentials,
} from './providers/webhook';
import {
  createWordPressAdapter,
  type WordPressConfig,
  type WordPressCredentials,
} from './providers/wordpress';

export * from './adapter';
export * from './crypto';
export * from './ssrf-guard';
export * from './providers/wordpress';
export * from './providers/ghost';
export * from './providers/webhook';

/**
 * FABBRICA DEGLI ADAPTER
 *
 * Un solo punto che, dato un provider e le credenziali già decifrate,
 * restituisce l'adapter giusto. Il worker di pubblicazione chiama questa
 * funzione e non sa nulla dei singoli CMS.
 *
 * NOTA: `credentials` arriva già in chiaro, decifrato da `createCipherFromEnv`.
 * La decifratura avviene un livello sopra, nel worker, che è l'unico processo a
 * possedere la chiave.
 */
export function createAdapter(
  provider: IntegrationProvider,
  credentials: Record<string, unknown>,
  config: Record<string, unknown> = {},
): CmsAdapter {
  switch (provider) {
    case 'wordpress':
    case 'wordpress_com':
      return createWordPressAdapter(
        credentials as unknown as WordPressCredentials,
        config as WordPressConfig,
      );

    case 'ghost':
      return createGhostAdapter(credentials as unknown as GhostCredentials);

    case 'webhook':
    case 'nextjs_blog':
      // Il blog Next.js consuma lo stesso payload firmato del webhook generico:
      // stessa firma HMAC, stesso schema. Non serve un adapter separato.
      return createWebhookAdapter(credentials as unknown as WebhookCredentials);

    default:
      throw new PublishError(
        `Provider non implementato: ${provider}`,
        'ADAPTER_NOT_IMPLEMENTED',
        false,
        `L’integrazione con ${provider} non è ancora disponibile. Usa il webhook generico nel frattempo.`,
      );
  }
}

/** Provider per cui esiste un adapter funzionante. */
export const SUPPORTED_PROVIDERS: IntegrationProvider[] = [
  'wordpress',
  'wordpress_com',
  'ghost',
  'webhook',
  'nextjs_blog',
];

export function isProviderSupported(provider: string): boolean {
  return SUPPORTED_PROVIDERS.includes(provider as IntegrationProvider);
}
