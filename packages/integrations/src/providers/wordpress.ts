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
 * ADAPTER WORDPRESS (REST API v2)
 *
 * Autenticazione via Application Password: WordPress 5.6+ le genera dal profilo
 * utente e sono revocabili singolarmente, senza toccare la password
 * dell'account. È l'unico metodo che non richiede plugin.
 *
 * Ogni richiesta passa da `safeFetch`: l'URL del sito è fornito dall'utente,
 * quindi è un potenziale vettore SSRF verso la rete interna.
 */

export interface WordPressCredentials {
  /** URL base del sito, es. https://esempio.it */
  siteUrl: string;
  username: string;
  /** Application Password (formato "xxxx xxxx xxxx xxxx"). */
  applicationPassword: string;
}

export interface WordPressConfig {
  /** Custom post type. Default: 'posts'. */
  postType?: string;
  /** ID delle categorie da assegnare. */
  categoryIds?: number[];
  /** Se true carica l'immagine di copertina nella libreria media. */
  uploadFeaturedImage?: boolean;
}

interface WpPost {
  id?: number;
  link?: string;
  status?: string;
  message?: string;
  code?: string;
}

export function createWordPressAdapter(
  credentials: WordPressCredentials,
  config: WordPressConfig = {},
): CmsAdapter {
  const base = credentials.siteUrl.replace(/\/$/, '');
  const postType = config.postType ?? 'posts';

  // WordPress accetta Basic Auth con l'Application Password al posto della
  // password reale. Gli spazi nel formato mostrato dalla UI vanno rimossi.
  const authHeader =
    'Basic ' +
    Buffer.from(
      `${credentials.username}:${credentials.applicationPassword.replace(/\s+/g, '')}`,
    ).toString('base64');

  const headers = {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: WpPost; raw: string }> {
    const url = `${base}/wp-json/wp/v2${path}`;

    let response: Response;
    try {
      response = await safeFetch(url, { ...init, headers }, { timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        throw new PublishError(
          `URL bloccato dal guard SSRF: ${error.reason}`,
          'WP_URL_BLOCKED',
          false,
          'L’indirizzo del sito WordPress non è raggiungibile pubblicamente o punta a una rete privata.',
        );
      }
      throw new PublishError(
        error instanceof Error ? error.message : 'Errore di rete',
        'WP_NETWORK_ERROR',
        true,
        'Il sito WordPress non ha risposto. Riproviamo automaticamente.',
      );
    }

    const raw = await response.text();
    let body: WpPost = {};
    try {
      body = raw ? (JSON.parse(raw) as WpPost) : {};
    } catch {
      // WordPress restituisce HTML quando la REST API è disabilitata o quando
      // un plugin di sicurezza intercetta la richiesta.
      if (!response.ok) {
        throw new PublishError(
          `Risposta non JSON (HTTP ${response.status})`,
          'WP_NON_JSON_RESPONSE',
          false,
          'Il sito non ha restituito una risposta valida: la REST API potrebbe essere disabilitata o bloccata da un plugin di sicurezza.',
          response.status,
        );
      }
    }

    return { status: response.status, body, raw };
  }

  return {
    provider: 'wordpress',

    async healthCheck(): Promise<HealthCheckResponse> {
      const startedAt = Date.now();

      try {
        // `/users/me` verifica in un colpo solo che le credenziali siano valide
        // e che l'utente esista: un 200 qui significa che possiamo autenticarci.
        // Il corpo non serve — ci basta il codice di stato.
        const { status } = await request('/users/me?context=edit');
        const durationMs = Date.now() - startedAt;

        if (status === 200) {
          return {
            result: 'ok',
            message: 'Connessione a WordPress attiva.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 401) {
          return {
            result: 'auth_failed',
            message:
              'Credenziali rifiutate. L’Application Password potrebbe essere stata revocata.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 403) {
          return {
            result: 'permission_denied',
            message:
              'L’utente collegato non ha i permessi necessari per pubblicare.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 404) {
          return {
            result: 'not_found',
            message:
              'REST API non trovata: verifica che l’URL del sito sia corretto e che /wp-json sia raggiungibile.',
            httpStatus: status,
            durationMs,
          };
        }

        if (status === 429) {
          return {
            result: 'rate_limited',
            message: 'Il sito ha limitato le richieste. Riproveremo più tardi.',
            httpStatus: status,
            durationMs,
          };
        }

        return {
          result: 'unknown_error',
          message: `Risposta inattesa dal sito (codice ${status}).`,
          httpStatus: status,
          durationMs,
        };
      } catch (error) {
        return {
          result:
            error instanceof PublishError && error.code === 'WP_URL_BLOCKED'
              ? 'unreachable'
              : 'unreachable',
          message:
            error instanceof PublishError
              ? error.userMessage
              : 'Il sito non è raggiungibile.',
          durationMs: Date.now() - startedAt,
        };
      }
    },

    async publish(article: ArticlePayload): Promise<PublishResponse> {
      const payload: Record<string, unknown> = {
        title: article.title,
        slug: article.slug,
        content: article.contentHtml,
        excerpt: article.excerpt ?? article.metaDescription,
        status: article.asDraft ? 'draft' : 'publish',
      };

      if (config.categoryIds?.length) {
        payload.categories = config.categoryIds;
      }

      const { status, body, raw } = await request(`/${postType}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (status !== 200 && status !== 201) {
        throw httpErrorToPublishError(status, 'wordpress', body.message ?? raw);
      }

      if (!body.id) {
        throw new PublishError(
          'WordPress non ha restituito un id',
          'WP_NO_ID',
          true,
          'Il sito ha accettato l’articolo ma non ha restituito un identificativo.',
        );
      }

      return {
        externalId: String(body.id),
        publishedUrl: body.link ?? `${base}/?p=${body.id}`,
        remoteStatus: body.status,
      };
    },

    async update(article: ArticlePayload): Promise<PublishResponse> {
      if (!article.externalId) {
        throw new PublishError(
          'externalId mancante',
          'WP_MISSING_EXTERNAL_ID',
          false,
          'Impossibile aggiornare: manca il riferimento all’articolo sul CMS.',
        );
      }

      const { status, body, raw } = await request(
        `/${postType}/${article.externalId}`,
        {
          method: 'POST', // WordPress accetta POST anche per l'update parziale
          body: JSON.stringify({
            title: article.title,
            content: article.contentHtml,
            excerpt: article.excerpt ?? article.metaDescription,
          }),
        },
      );

      if (status !== 200) {
        throw httpErrorToPublishError(status, 'wordpress', body.message ?? raw);
      }

      return {
        externalId: String(body.id ?? article.externalId),
        publishedUrl: body.link ?? `${base}/?p=${article.externalId}`,
        remoteStatus: body.status,
      };
    },

    async unpublish(externalId: string): Promise<void> {
      // Senza `force=true` WordPress sposta nel cestino invece di eliminare.
      // È il comportamento voluto: la rimozione definitiva deve restare una
      // decisione del proprietario del sito.
      const { status, body, raw } = await request(
        `/${postType}/${externalId}`,
        { method: 'DELETE' },
      );

      if (status !== 200) {
        throw httpErrorToPublishError(status, 'wordpress', body.message ?? raw);
      }
    },
  };
}
