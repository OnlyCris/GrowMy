/**
 * GOOGLE SEARCH CONSOLE — OAuth e lettura delle metriche.
 *
 * Sta in `@growmy/integrations` e non in un pacchetto proprio per un motivo
 * preciso: GSC segue esattamente la stessa disciplina delle credenziali CMS
 * (token cifrati AES-256-GCM con `crypto.ts`, chiave presente solo nel
 * worker). Tenerlo accanto rende evidente che è lo stesso contratto, non un
 * secondo modo di gestire segreti di terze parti.
 *
 * NON è un `CmsAdapter`: quell'interfaccia descrive la pubblicazione (connect/
 * healthCheck/publish/update). Qui il flusso è opposto — si legge soltanto, e
 * il dato entra nel planner. Forzarlo in `adapter.ts` avrebbe prodotto un
 * adapter con metà dei metodi che lanciano "non supportato".
 *
 * SCOPE RICHIESTO: `webmasters.readonly`. Sola lettura, deliberato: la
 * piattaforma non ha alcuna ragione di modificare le property Search Console
 * di un cliente, e chiedere un permesso di scrittura che non si usa è il
 * genere di dettaglio che fa (giustamente) rifiutare il consenso.
 */

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3';

/**
 * `webmasters.readonly` per i dati, `userinfo.email` per mostrare in UI QUALE
 * account Google è collegato — senza, l'utente con più account non ha modo di
 * sapere quale ha autorizzato, e la diagnosi di "non vedo i miei dati" diventa
 * indovinare.
 */
export const GSC_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

export class GscError extends Error {
  constructor(
    message: string,
    /** Codice macchina, per decidere se ritentare. */
    readonly code: string,
    /** Se `false`, ritentare non serve: serve un intervento umano. */
    readonly retryable: boolean,
    /** Messaggio già scritto per l'utente finale, senza gergo HTTP. */
    readonly userMessage: string,
  ) {
    super(message);
    this.name = 'GscError';
  }
}

/**
 * Traduce una risposta HTTP di Google in un errore di dominio.
 *
 * La distinzione che conta è fra "ritenta" e "non ritentare": un 401 su un
 * refresh token significa che l'utente ha revocato l'accesso dalla propria
 * pagina Google, e nessun numero di tentativi lo riporterà indietro — va
 * mostrato in UI come connessione da rifare, non nascosto in un retry loop.
 */
async function toGscError(response: Response, context: string): Promise<GscError> {
  const body = await response.text().catch(() => '');

  if (response.status === 401 || response.status === 403) {
    return new GscError(
      `${context}: ${response.status} ${body.slice(0, 300)}`,
      'GSC_AUTH_FAILED',
      false,
      'Google ha rifiutato l’accesso a Search Console. Ricollega la property: ' +
        'il permesso potrebbe essere stato revocato o l’account non ha più accesso al sito.',
    );
  }

  if (response.status === 429) {
    return new GscError(
      `${context}: quota superata`,
      'GSC_RATE_LIMITED',
      true,
      'Google ha temporaneamente limitato le richieste. La sincronizzazione riprenderà da sola.',
    );
  }

  if (response.status >= 500) {
    return new GscError(
      `${context}: ${response.status}`,
      'GSC_UNAVAILABLE',
      true,
      'Search Console non è raggiungibile in questo momento. Riproveremo automaticamente.',
    );
  }

  return new GscError(
    `${context}: ${response.status} ${body.slice(0, 300)}`,
    'GSC_REQUEST_FAILED',
    false,
    'Richiesta a Search Console non riuscita.',
  );
}

// ---------------------------------------------------------------------------
// 1. OAuth
// ---------------------------------------------------------------------------

/**
 * URL della schermata di consenso Google.
 *
 * `access_type=offline` + `prompt=consent` sono ENTRAMBI necessari e la
 * ragione non è ovvia: Google restituisce il refresh token **una sola volta**,
 * alla primissima autorizzazione di quell'utente per quel client. Se l'utente
 * ha già autorizzato in passato (o sta ricollegando dopo un errore), senza
 * `prompt=consent` la risposta contiene solo un access token di un'ora e la
 * connessione muore silenziosamente il giorno dopo. Forzare il consenso costa
 * un clic in più e rende il flusso ripetibile.
 */
export function buildGscConsentUrl(params: {
  clientId: string;
  redirectUri: string;
  /** Token firmato anti-CSRF, verificato al callback. */
  state: string;
  /** Preseleziona l'account, se lo conosciamo da una connessione precedente. */
  loginHint?: string | null;
}): string {
  const url = new URL(OAUTH_AUTH_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GSC_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', params.state);
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

export interface GscTokens {
  accessToken: string;
  /** Presente solo alla prima autorizzazione: va conservato cifrato. */
  refreshToken: string | null;
  expiresInSeconds: number;
  grantedScopes: string[];
}

/** Scambia il `code` del callback con i token. Il code è monouso e dura ~10 min. */
export async function exchangeGscCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<GscTokens> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) throw await toGscError(response, 'Scambio del codice OAuth');

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  /**
   * Verifica che l'utente non abbia deselezionato Search Console nella
   * schermata di consenso (Google permette di concedere solo una parte degli
   * scope richiesti). Senza questo controllo la connessione risulterebbe
   * riuscita e fallirebbe alla prima query, con un 403 molto meno chiaro.
   */
  const granted = (data.scope ?? '').split(' ').filter(Boolean);
  if (!granted.includes(GSC_SCOPES[0])) {
    throw new GscError(
      `Scope mancante. Concessi: ${granted.join(', ') || 'nessuno'}`,
      'GSC_SCOPE_DENIED',
      false,
      'Il permesso di lettura su Search Console non è stato concesso. ' +
        'Riprova lasciando selezionata la voce relativa a Search Console.',
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresInSeconds: data.expires_in,
    grantedScopes: granted,
  };
}

/** Rinnova l'access token. Il refresh token resta valido finché non è revocato. */
export async function refreshGscAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) throw await toGscError(response, 'Rinnovo del token');

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
}

/** Email dell'account collegato, mostrata in UI. */
export async function fetchGscAccountEmail(accessToken: string): Promise<string | null> {
  const response = await fetch(USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  // Non fatale: senza email la connessione funziona comunque, mostreremo la
  // sola property. Non vale la pena far fallire un collegamento per questo.
  if (!response.ok) return null;

  const data = (await response.json()) as { email?: string };
  return data.email ?? null;
}

// ---------------------------------------------------------------------------
// 2. Property
// ---------------------------------------------------------------------------

export interface GscSite {
  /** Es. `sc-domain:acme.com` oppure `https://acme.com/`. */
  siteUrl: string;
  /** `siteOwner` | `siteFullUser` | `siteRestrictedUser` | `siteUnverifiedUser`. */
  permissionLevel: string;
}

/** Property visibili all'account. Serve a far scegliere quella giusta all'utente. */
export async function listGscSites(accessToken: string): Promise<GscSite[]> {
  const response = await fetch(`${WEBMASTERS_BASE}/sites`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) throw await toGscError(response, 'Elenco delle property');

  const data = (await response.json()) as {
    siteEntry?: Array<{ siteUrl: string; permissionLevel: string }>;
  };

  return (data.siteEntry ?? [])
    // `siteUnverifiedUser` non può leggere alcun dato: mostrarla produrrebbe
    // solo una connessione che sembra riuscita e resta vuota per sempre.
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

// ---------------------------------------------------------------------------
// 3. Search Analytics
// ---------------------------------------------------------------------------

export interface GscMetricRow {
  date: string;
  page: string;
  query: string;
  country: string | null;
  device: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Massimo consentito da Google in una singola risposta. */
const MAX_ROWS_PER_PAGE = 25_000;

/**
 * Scarica le metriche per (data, pagina, query) in un intervallo.
 *
 * PAGINAZIONE: l'API restituisce al massimo 25.000 righe per chiamata e si
 * scorre con `startRow`. Un sito medio con tre mesi di storico supera
 * abbondantemente quella soglia, quindi la paginazione non è un caso limite:
 * è il caso normale. Il ciclo si ferma quando una pagina torna incompleta.
 *
 * `maxRows` esiste per non trasformare la prima sincronizzazione di un sito
 * grande in un job che gira per ore e satura la quota giornaliera dell'account.
 */
export async function fetchGscMetrics(params: {
  accessToken: string;
  siteUrl: string;
  /** Formato `YYYY-MM-DD`, inclusa. */
  startDate: string;
  /** Formato `YYYY-MM-DD`, inclusa. */
  endDate: string;
  maxRows?: number;
  /** Chiamata dopo ogni pagina: consente al worker di scrivere a blocchi. */
  onPage?: (rows: GscMetricRow[]) => Promise<void>;
}): Promise<GscMetricRow[]> {
  const maxRows = params.maxRows ?? 100_000;
  const endpoint = `${WEBMASTERS_BASE}/sites/${encodeURIComponent(params.siteUrl)}/searchAnalytics/query`;

  const collected: GscMetricRow[] = [];
  let startRow = 0;

  while (collected.length < maxRows) {
    const rowLimit = Math.min(MAX_ROWS_PER_PAGE, maxRows - collected.length);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ['date', 'page', 'query', 'country', 'device'],
        rowLimit,
        startRow,
        /**
         * `dataState: 'all'` include i giorni ancora "freschi" che Google non
         * ha finalizzato. Deliberatamente NON usato: quei numeri cambiano nei
         * giorni successivi, e il planner prenderebbe decisioni su dati che si
         * muovono sotto i piedi. Il default (`final`) è la scelta giusta qui.
         */
        type: 'web',
      }),
    });

    if (!response.ok) throw await toGscError(response, 'Query Search Analytics');

    const data = (await response.json()) as {
      rows?: Array<{
        keys: string[];
        clicks: number;
        impressions: number;
        ctr: number;
        position: number;
      }>;
    };

    const rows = data.rows ?? [];
    if (rows.length === 0) break;

    // `keys` segue l'ordine di `dimensions` richiesto sopra.
    const mapped: GscMetricRow[] = rows.map((r) => ({
      date: r.keys[0],
      page: r.keys[1],
      query: r.keys[2],
      country: r.keys[3] ?? null,
      device: r.keys[4] ?? null,
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));

    if (params.onPage) await params.onPage(mapped);
    collected.push(...mapped);

    // Pagina incompleta = ultima pagina.
    if (rows.length < rowLimit) break;
    startRow += rows.length;
  }

  return collected;
}

/**
 * Data più recente per cui Google ha dati consolidati.
 *
 * Search Console pubblica con 2-3 giorni di ritardo. Chiedere fino a "ieri"
 * restituisce zero righe per gli ultimi giorni e — peggio — farebbe avanzare
 * `lastSyncedDate` su un intervallo vuoto, saltando per sempre quei giorni
 * quando i dati arriveranno davvero.
 */
export function latestAvailableGscDate(now: Date = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - 3);
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` con offset in giorni. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
