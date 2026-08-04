/**
 * INTERFACCIA COMUNE DEGLI ADAPTER CMS
 *
 * Un contratto solo per WordPress, Ghost, Webflow e webhook generici. Il worker
 * di pubblicazione non sa su quale CMS sta scrivendo: chiama `publish` e riceve
 * un URL.
 *
 * I quattro metodi corrispondono al ciclo di vita di un'integrazione:
 *   healthCheck  — verifica preventiva, eseguita ogni 24h (UPGRADE #3)
 *   publish      — prima pubblicazione
 *   update       — aggiornamento di un articolo già pubblicato (refresh)
 *   unpublish    — rimozione, per i casi di consolidamento
 */

export type IntegrationProvider =
  | 'wordpress'
  | 'wordpress_com'
  | 'webflow'
  | 'shopify'
  | 'ghost'
  | 'notion'
  | 'wix'
  | 'framer'
  | 'webhook'
  | 'nextjs_blog';

/** Esito di un health check, allineato all'enum del database. */
export type HealthCheckResult =
  | 'ok'
  | 'auth_failed'
  | 'permission_denied'
  | 'not_found'
  | 'rate_limited'
  | 'unreachable'
  | 'schema_mismatch'
  | 'unknown_error';

export interface HealthCheckResponse {
  result: HealthCheckResult;
  /** Messaggio già scritto per l'utente finale, mai uno stack trace. */
  message: string;
  httpStatus?: number;
  durationMs: number;
}

export interface ArticlePayload {
  title: string;
  slug: string;
  contentMarkdown: string;
  /** HTML derivato dal Markdown: molti CMS non accettano Markdown. */
  contentHtml: string;
  metaDescription: string;
  excerpt?: string | null;
  featuredImageUrl?: string | null;
  tags?: string[];
  /** Pubblica come bozza invece che live. */
  asDraft: boolean;
  /** ID sul CMS remoto, presente solo negli aggiornamenti. */
  externalId?: string | null;
}

export interface PublishResponse {
  externalId: string;
  publishedUrl: string;
  /** Stato riportato dal CMS ('draft', 'published'...). */
  remoteStatus?: string;
}

/**
 * Errore di pubblicazione con la distinzione che serve al retry.
 *
 * `retryable` separa i problemi transitori (rete, 503, rate limit) da quelli
 * che richiedono un intervento umano (token revocato, permessi mancanti).
 * Ritentare un errore permanente consuma tentativi e ritarda l'avviso
 * all'utente.
 *
 * `userMessage` è ciò che compare in `article_publications.error_message` e
 * quindi nell'interfaccia: deve dire cosa fare, non cosa è successo nello stack.
 */
export class PublishError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly userMessage: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export interface CmsAdapter {
  readonly provider: IntegrationProvider;

  /** Verifica che le credenziali funzionino e che i permessi bastino. */
  healthCheck(): Promise<HealthCheckResponse>;

  publish(article: ArticlePayload): Promise<PublishResponse>;

  update(article: ArticlePayload): Promise<PublishResponse>;

  unpublish(externalId: string): Promise<void>;
}

/**
 * Traduce un codice HTTP in un errore di pubblicazione tipizzato.
 * Centralizzarlo qui evita che ogni adapter reinventi la classificazione e
 * produca messaggi incoerenti fra un CMS e l'altro.
 */
export function httpErrorToPublishError(
  status: number,
  provider: IntegrationProvider,
  detail?: string,
): PublishError {
  const shortDetail = detail?.slice(0, 200) ?? '';

  switch (true) {
    case status === 401:
      return new PublishError(
        `${provider} 401: ${shortDetail}`,
        `${provider.toUpperCase()}_401_UNAUTHORIZED`,
        false,
        'Le credenziali non sono più valide. Riconnetti l’integrazione dalle impostazioni.',
        status,
      );

    case status === 403:
      return new PublishError(
        `${provider} 403: ${shortDetail}`,
        `${provider.toUpperCase()}_403_FORBIDDEN`,
        false,
        'L’account collegato non ha i permessi per pubblicare. Verifica il ruolo dell’utente sul CMS.',
        status,
      );

    case status === 404:
      return new PublishError(
        `${provider} 404: ${shortDetail}`,
        `${provider.toUpperCase()}_404_NOT_FOUND`,
        false,
        'La risorsa richiesta non esiste sul CMS. L’URL o la collezione configurata potrebbe essere cambiata.',
        status,
      );

    case status === 429:
      return new PublishError(
        `${provider} 429: ${shortDetail}`,
        `${provider.toUpperCase()}_429_RATE_LIMITED`,
        true,
        'Il CMS ha temporaneamente limitato le richieste. Riproviamo automaticamente.',
        status,
      );

    case status >= 500:
      return new PublishError(
        `${provider} ${status}: ${shortDetail}`,
        `${provider.toUpperCase()}_${status}_SERVER_ERROR`,
        true,
        'Il CMS ha risposto con un errore temporaneo. Riproviamo automaticamente.',
        status,
      );

    default:
      return new PublishError(
        `${provider} ${status}: ${shortDetail}`,
        `${provider.toUpperCase()}_${status}`,
        false,
        `Il CMS ha rifiutato la richiesta (codice ${status}). Controlla la configurazione dell’integrazione.`,
        status,
      );
  }
}

/**
 * Converte Markdown in HTML.
 *
 * Implementazione minimale e deliberata: nessuna dipendenza esterna per una
 * trasformazione che dobbiamo controllare al byte. L'HTML finisce sul sito di
 * un cliente, quindi ogni carattere non riconosciuto viene ESCAPED invece che
 * passato — un parser permissivo qui sarebbe un vettore di XSS sul loro dominio.
 */
export function markdownToHtml(markdown: string): string {
  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** Grassetto, corsivo, codice inline e link, su testo già escapato. */
  const inline = (text: string): string =>
    escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
        // Allowlist di schema: `javascript:` e `data:` non diventano mai link.
        const safe = /^(?:https?:\/\/|\/)/i.test(href);
        return safe
          ? `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`
          : label;
      });

  const lines = markdown.split('\n');
  const html: string[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let insideFence = false;
  let fenceBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0 || !listType) return;
    const items = listItems.map((item) => `<li>${inline(item)}</li>`).join('');
    html.push(`<${listType}>${items}</${listType}>`);
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    // Blocchi di codice: contenuto preservato ma interamente escapato.
    if (/^\s*```/.test(line)) {
      if (insideFence) {
        html.push(`<pre><code>${escapeHtml(fenceBuffer.join('\n'))}</code></pre>`);
        fenceBuffer = [];
        insideFence = false;
      } else {
        flushParagraph();
        flushList();
        insideFence = true;
      }
      continue;
    }

    if (insideFence) {
      fenceBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      listItems.push(numbered[1]);
      continue;
    }

    const quote = /^>\s*(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`);
      continue;
    }

    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr />');
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  // Un blocco di codice non chiuso non deve far perdere il contenuto.
  if (insideFence && fenceBuffer.length > 0) {
    html.push(`<pre><code>${escapeHtml(fenceBuffer.join('\n'))}</code></pre>`);
  }

  flushParagraph();
  flushList();

  return html.join('\n');
}
