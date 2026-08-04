import { createHmac, randomUUID } from 'node:crypto';

import {
  httpErrorToPublishError,
  PublishError,
  type ArticlePayload,
  type CmsAdapter,
  type HealthCheckResponse,
  type PublishResponse,
} from '../adapter';
import { safeFetch, SsrfBlockedError } from '../ssrf-guard';

/**
 * ADAPTER WEBHOOK GENERICO
 *
 * Consegna l'articolo come JSON a un endpoint scelto dal cliente. È la via per
 * integrare qualunque piattaforma che non abbia un adapter dedicato.
 *
 * FIRMA HMAC — la parte che rende utile questo adapter.
 *
 * Il destinatario deve poter verificare che una consegna venga davvero da noi e
 * non da un terzo che ha indovinato l'URL. Ogni richiesta porta:
 *
 *   X-GrowMy-Signature  sha256=<hmac del timestamp + corpo>
 *   X-GrowMy-Timestamp  epoch in secondi
 *   X-GrowMy-Delivery   uuid della consegna
 *
 * Il timestamp è DENTRO la firma: senza, un attaccante potrebbe catturare una
 * consegna valida e rigiocarla all'infinito. Il destinatario deve rifiutare
 * timestamp più vecchi di qualche minuto.
 *
 * SSRF: l'URL è fornito dall'utente e potrebbe puntare alla rete interna.
 * `safeFetch` lo valida e rivalida a ogni redirect.
 */

export interface WebhookCredentials {
  targetUrl: string;
  /** Segreto condiviso per la firma HMAC. */
  signingSecret: string;
  /** Header aggiuntivi, es. una chiave API del destinatario. */
  extraHeaders?: Record<string, string>;
}

export interface WebhookPayload {
  event: 'article.published' | 'article.updated' | 'article.unpublished' | 'ping';
  deliveryId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

interface WebhookAck {
  /** Id assegnato dal destinatario. Se assente usiamo il deliveryId. */
  id?: string;
  externalId?: string;
  url?: string;
  status?: string;
}

/**
 * Calcola la firma. Il formato `sha256=<hex>` segue la convenzione di GitHub e
 * Stripe: rende ovvio l'algoritmo al destinatario e consente di cambiarlo in
 * futuro senza ambiguità.
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  body: string,
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return `sha256=${signature}`;
}

export function createWebhookAdapter(
  credentials: WebhookCredentials,
): CmsAdapter {
  async function deliver(
    payload: WebhookPayload,
  ): Promise<{ status: number; body: WebhookAck; raw: string }> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    let response: Response;
    try {
      response = await safeFetch(
        credentials.targetUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'GrowMy-Webhook/1.0',
            'X-GrowMy-Signature': signWebhookPayload(
              credentials.signingSecret,
              timestamp,
              body,
            ),
            'X-GrowMy-Timestamp': timestamp,
            'X-GrowMy-Delivery': payload.deliveryId,
            'X-GrowMy-Event': payload.event,
            ...credentials.extraHeaders,
          },
          body,
        },
        { timeoutMs: 20_000, maxRedirects: 2 },
      );
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new PublishError(
          `URL bloccato dal guard SSRF: ${error.reason}`,
          'WEBHOOK_URL_BLOCKED',
          false,
          'L’endpoint configurato punta a un indirizzo privato o non consentito.',
        );
      }
      throw new PublishError(
        error instanceof Error ? error.message : 'Errore di rete',
        'WEBHOOK_NETWORK_ERROR',
        true,
        'L’endpoint non ha risposto. Riproviamo automaticamente.',
      );
    }

    // Il corpo di risposta è troncato: un destinatario che restituisce
    // megabyte di HTML non deve riempirci i log.
    const raw = (await response.text().catch(() => '')).slice(0, 1_024);

    let parsed: WebhookAck = {};
    try {
      parsed = raw ? (JSON.parse(raw) as WebhookAck) : {};
    } catch {
      // Una risposta non JSON è accettabile: molti endpoint rispondono 200
      // con corpo vuoto. Ci basta il codice di stato.
    }

    return { status: response.status, body: parsed, raw };
  }

  return {
    provider: 'webhook',

    async healthCheck(): Promise<HealthCheckResponse> {
      const startedAt = Date.now();

      try {
        const { status } = await deliver({
          event: 'ping',
          deliveryId: randomUUID(),
          timestamp: new Date().toISOString(),
          data: { message: 'Verifica di connettività da GrowMy.' },
        });

        const durationMs = Date.now() - startedAt;

        if (status >= 200 && status < 300) {
          return {
            result: 'ok',
            message: 'L’endpoint risponde correttamente.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 401 || status === 403) {
          return {
            result: status === 401 ? 'auth_failed' : 'permission_denied',
            message:
              'L’endpoint ha rifiutato la richiesta: verifica il segreto di firma o gli header aggiuntivi.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 404) {
          return {
            result: 'not_found',
            message: 'L’endpoint configurato non esiste.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 429) {
          return {
            result: 'rate_limited',
            message: 'L’endpoint ha limitato le richieste.',
            httpStatus: status,
            durationMs,
          };
        }

        return {
          result: 'unknown_error',
          message: `L’endpoint ha risposto ${status}.`,
          httpStatus: status,
          durationMs,
        };
      } catch (error) {
        return {
          result: 'unreachable',
          message:
            error instanceof PublishError
              ? error.userMessage
              : 'L’endpoint non è raggiungibile.',
          durationMs: Date.now() - startedAt,
        };
      }
    },

    async publish(article: ArticlePayload): Promise<PublishResponse> {
      const deliveryId = randomUUID();

      const { status, body, raw } = await deliver({
        event: 'article.published',
        deliveryId,
        timestamp: new Date().toISOString(),
        data: {
          title: article.title,
          slug: article.slug,
          contentMarkdown: article.contentMarkdown,
          contentHtml: article.contentHtml,
          metaDescription: article.metaDescription,
          excerpt: article.excerpt,
          featuredImageUrl: article.featuredImageUrl,
          tags: article.tags ?? [],
          isDraft: article.asDraft,
        },
      });

      if (status < 200 || status >= 300) {
        throw httpErrorToPublishError(status, 'webhook', raw);
      }

      return {
        // Se il destinatario restituisce un proprio id lo conserviamo: serve
        // per gli aggiornamenti successivi.
        externalId: body.externalId ?? body.id ?? deliveryId,
        publishedUrl: body.url ?? credentials.targetUrl,
        remoteStatus: body.status,
      };
    },

    async update(article: ArticlePayload): Promise<PublishResponse> {
      const deliveryId = randomUUID();

      const { status, body, raw } = await deliver({
        event: 'article.updated',
        deliveryId,
        timestamp: new Date().toISOString(),
        data: {
          externalId: article.externalId,
          title: article.title,
          slug: article.slug,
          contentMarkdown: article.contentMarkdown,
          contentHtml: article.contentHtml,
          metaDescription: article.metaDescription,
          excerpt: article.excerpt,
          featuredImageUrl: article.featuredImageUrl,
          tags: article.tags ?? [],
        },
      });

      if (status < 200 || status >= 300) {
        throw httpErrorToPublishError(status, 'webhook', raw);
      }

      return {
        externalId: body.externalId ?? article.externalId ?? deliveryId,
        publishedUrl: body.url ?? credentials.targetUrl,
        remoteStatus: body.status,
      };
    },

    async unpublish(externalId: string): Promise<void> {
      const { status, raw } = await deliver({
        event: 'article.unpublished',
        deliveryId: randomUUID(),
        timestamp: new Date().toISOString(),
        data: { externalId },
      });

      if (status < 200 || status >= 300) {
        throw httpErrorToPublishError(status, 'webhook', raw);
      }
    },
  };
}
