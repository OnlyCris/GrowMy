import { createHmac } from 'node:crypto';

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
 * ADAPTER GHOST (Admin API v5)
 *
 * Ghost autentica con un JWT firmato che dura 5 minuti, generato a partire
 * dalla Admin API Key nel formato `id:secret`. Lo costruiamo a mano — è un
 * HS256 standard — invece di aggiungere una libreria JWT per una firma di
 * dodici righe.
 *
 * PARTICOLARITÀ: Ghost 5 usa l'editor Lexical, ma accetta ancora HTML tramite
 * il parametro `?source=html`. Senza quel parametro il campo `html` viene
 * ignorato in silenzio e l'articolo esce vuoto: è l'errore più comune con
 * questa integrazione.
 */

export interface GhostCredentials {
  /** URL dell'installazione, es. https://blog.esempio.it */
  apiUrl: string;
  /** Admin API Key nel formato `<id>:<secret>`. */
  adminApiKey: string;
}

interface GhostPost {
  id?: string;
  url?: string;
  status?: string;
  updated_at?: string;
}

interface GhostResponse {
  posts?: GhostPost[];
  errors?: Array<{ message?: string; type?: string }>;
}

/**
 * Genera il JWT per la Admin API.
 * Header e payload sono base64url, la firma è HMAC-SHA256 del segreto
 * decodificato da esadecimale.
 */
function createGhostToken(adminApiKey: string): string {
  const [id, secret] = adminApiKey.split(':');

  if (!id || !secret) {
    throw new PublishError(
      'Formato della Admin API Key non valido',
      'GHOST_INVALID_KEY_FORMAT',
      false,
      'La Admin API Key di Ghost deve essere nel formato "id:secret". Copiala dalle impostazioni di integrazione.',
    );
  }

  const base64url = (input: Buffer | string): string =>
    (typeof input === 'string' ? Buffer.from(input) : input)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const now = Math.floor(Date.now() / 1000);

  const header = base64url(
    JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }),
  );
  const payload = base64url(
    JSON.stringify({
      iat: now,
      // Ghost rifiuta token con scadenza superiore a 5 minuti.
      exp: now + 300,
      aud: '/admin/',
    }),
  );

  const signature = base64url(
    createHmac('sha256', Buffer.from(secret, 'hex'))
      .update(`${header}.${payload}`)
      .digest(),
  );

  return `${header}.${payload}.${signature}`;
}

export function createGhostAdapter(
  credentials: GhostCredentials,
): CmsAdapter {
  const base = credentials.apiUrl.replace(/\/$/, '');

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: GhostResponse; raw: string }> {
    const token = createGhostToken(credentials.adminApiKey);
    const url = `${base}/ghost/api/admin${path}`;

    let response: Response;
    try {
      response = await safeFetch(
        url,
        {
          ...init,
          headers: {
            Authorization: `Ghost ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            // Ghost richiede lo user-agent con la versione supportata.
            'Accept-Version': 'v5.0',
          },
        },
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new PublishError(
          `URL bloccato dal guard SSRF: ${error.reason}`,
          'GHOST_URL_BLOCKED',
          false,
          'L’indirizzo della pubblicazione Ghost non è raggiungibile pubblicamente.',
        );
      }
      throw new PublishError(
        error instanceof Error ? error.message : 'Errore di rete',
        'GHOST_NETWORK_ERROR',
        true,
        'La pubblicazione Ghost non ha risposto. Riproviamo automaticamente.',
      );
    }

    const raw = await response.text();
    let body: GhostResponse = {};
    try {
      body = raw ? (JSON.parse(raw) as GhostResponse) : {};
    } catch {
      if (!response.ok) {
        throw new PublishError(
          `Risposta non JSON (HTTP ${response.status})`,
          'GHOST_NON_JSON_RESPONSE',
          false,
          'Ghost non ha restituito una risposta valida. Verifica l’URL dell’installazione.',
          response.status,
        );
      }
    }

    return { status: response.status, body, raw };
  }

  const errorDetail = (body: GhostResponse, raw: string): string =>
    body.errors?.map((e) => e.message).join('; ') ?? raw;

  return {
    provider: 'ghost',

    async healthCheck(): Promise<HealthCheckResponse> {
      const startedAt = Date.now();

      try {
        const { status, body, raw } = await request('/site/');
        const durationMs = Date.now() - startedAt;

        if (status === 200) {
          return {
            result: 'ok',
            message: 'Connessione a Ghost attiva.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 401 || status === 403) {
          return {
            result: status === 401 ? 'auth_failed' : 'permission_denied',
            message:
              'La Admin API Key non è più valida o l’integrazione è stata rimossa da Ghost.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 404) {
          return {
            result: 'not_found',
            message:
              'Admin API non trovata: verifica l’URL dell’installazione Ghost.',
            httpStatus: status,
            durationMs,
          };
        }

        return {
          result: 'unknown_error',
          message: `Risposta inattesa da Ghost (codice ${status}): ${errorDetail(body, raw).slice(0, 120)}`,
          httpStatus: status,
          durationMs,
        };
      } catch (error) {
        return {
          result: 'unreachable',
          message:
            error instanceof PublishError
              ? error.userMessage
              : 'La pubblicazione Ghost non è raggiungibile.',
          durationMs: Date.now() - startedAt,
        };
      }
    },

    async publish(article: ArticlePayload): Promise<PublishResponse> {
      const post: Record<string, unknown> = {
        title: article.title,
        slug: article.slug,
        html: article.contentHtml,
        custom_excerpt: article.excerpt ?? article.metaDescription,
        meta_description: article.metaDescription,
        status: article.asDraft ? 'draft' : 'published',
      };

      if (article.featuredImageUrl) post.feature_image = article.featuredImageUrl;
      if (article.tags?.length) post.tags = article.tags.map((name) => ({ name }));

      // `?source=html`: senza, Ghost ignora il campo `html` e crea un post vuoto.
      const { status, body, raw } = await request('/posts/?source=html', {
        method: 'POST',
        body: JSON.stringify({ posts: [post] }),
      });

      if (status !== 200 && status !== 201) {
        throw httpErrorToPublishError(status, 'ghost', errorDetail(body, raw));
      }

      const created = body.posts?.[0];
      if (!created?.id) {
        throw new PublishError(
          'Ghost non ha restituito il post creato',
          'GHOST_NO_POST',
          true,
          'Ghost ha accettato la richiesta ma non ha restituito l’articolo creato.',
        );
      }

      return {
        externalId: created.id,
        publishedUrl: created.url ?? `${base}/${article.slug}/`,
        remoteStatus: created.status,
      };
    },

    async update(article: ArticlePayload): Promise<PublishResponse> {
      if (!article.externalId) {
        throw new PublishError(
          'externalId mancante',
          'GHOST_MISSING_EXTERNAL_ID',
          false,
          'Impossibile aggiornare: manca il riferimento all’articolo su Ghost.',
        );
      }

      // Ghost richiede `updated_at` per il controllo di concorrenza
      // ottimistico: senza, rifiuta l'update con 409. Lo leggiamo prima.
      const current = await request(`/posts/${article.externalId}/`);
      const updatedAt = current.body.posts?.[0]?.updated_at;

      if (!updatedAt) {
        throw new PublishError(
          'Post non trovato su Ghost',
          'GHOST_POST_NOT_FOUND',
          false,
          'L’articolo non esiste più su Ghost: potrebbe essere stato eliminato a mano.',
        );
      }

      const { status, body, raw } = await request(
        `/posts/${article.externalId}/?source=html`,
        {
          method: 'PUT',
          body: JSON.stringify({
            posts: [
              {
                title: article.title,
                html: article.contentHtml,
                custom_excerpt: article.excerpt ?? article.metaDescription,
                meta_description: article.metaDescription,
                updated_at: updatedAt,
              },
            ],
          }),
        },
      );

      if (status !== 200) {
        throw httpErrorToPublishError(status, 'ghost', errorDetail(body, raw));
      }

      const updated = body.posts?.[0];
      return {
        externalId: updated?.id ?? article.externalId,
        publishedUrl: updated?.url ?? `${base}/${article.slug}/`,
        remoteStatus: updated?.status,
      };
    },

    async unpublish(externalId: string): Promise<void> {
      const { status, body, raw } = await request(`/posts/${externalId}/`, {
        method: 'DELETE',
      });

      // Ghost risponde 204 senza corpo su eliminazione riuscita.
      if (status !== 200 && status !== 204) {
        throw httpErrorToPublishError(status, 'ghost', errorDetail(body, raw));
      }
    },
  };
}
