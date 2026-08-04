import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * PROTEZIONE SSRF
 *
 * La piattaforma fa richieste HTTP verso URL forniti dall'utente: crawla il
 * dominio di un prodotto, pubblica su un'installazione WordPress arbitraria,
 * consegna webhook a endpoint scelti dal cliente.
 *
 * Senza controlli, un utente potrebbe far chiamare al nostro server:
 *  - `http://169.254.169.254/latest/meta-data/` — le credenziali IAM del cloud;
 *  - `http://localhost:5432` — il database, raggiungibile solo dall'interno;
 *  - `http://192.168.1.1` — dispositivi sulla rete privata dell'host.
 *
 * È Server-Side Request Forgery, e su un prodotto che accetta URL è la
 * vulnerabilità più prevedibile.
 *
 * DIFESA IN DUE TEMPI:
 *  1. Validazione dell'URL: schema, porta, hostname sospetti.
 *  2. RISOLUZIONE DNS e controllo dell'IP REALE. Il passo 2 è indispensabile:
 *     un attaccante può registrare un dominio pubblico che risolve a
 *     127.0.0.1, superando qualunque controllo basato sul solo hostname.
 */

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Solo HTTP e HTTPS: esclude file:, gopher:, ftp: e schemi esotici. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Porte consentite. Una allowlist è più sicura di una blocklist: non dobbiamo
 * indovinare tutte le porte interne interessanti, basta permettere quelle che
 * un CMS pubblico usa davvero.
 */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/** Hostname che non devono mai essere raggiunti, anche prima del DNS. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

/**
 * Verifica se un IPv4 appartiene a un intervallo non instradabile o interno.
 * Copre RFC 1918, loopback, link-local, CGNAT e gli endpoint di metadata cloud.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;

  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 — privata
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local e metadata cloud
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — privata
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — privata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 — riservata IETF
  if (a >= 224) return true; // multicast e riservati

  return false;
}

/** Come sopra, per IPv6. Include gli indirizzi IPv4-mapped. */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');

  if (normalized === '::1' || normalized === '::') return true; // loopback e unspecified
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // fc00::/7 — unique local
  if (normalized.startsWith('ff')) return true; // multicast

  // IPv4-mapped (::ffff:127.0.0.1): l'aggiramento più comune.
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // non è un IP valido: blocca per prudenza
}

export interface SsrfGuardOptions {
  /** Consente porte aggiuntive oltre a quelle di default. */
  extraAllowedPorts?: number[];
  /**
   * Salta il controllo DNS. SOLO per i test: disattiva la difesa principale.
   */
  skipDnsResolution?: boolean;
}

/**
 * Valida un URL fornito dall'utente prima di usarlo in una richiesta HTTP.
 * Ritorna l'URL normalizzato, oppure lancia `SsrfBlockedError`.
 */
export async function assertSafeUrl(
  rawUrl: string,
  options: SsrfGuardOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('URL non valido.', rawUrl, 'malformed');
  }

  // --- 1. Schema ----------------------------------------------------------
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(
      `Schema non consentito: ${url.protocol}. Sono ammessi solo http e https.`,
      rawUrl,
      'protocol',
    );
  }

  // --- 2. Credenziali nell'URL -------------------------------------------
  // `http://user:pass@host` è usato per confondere i parser: il browser e il
  // server possono interpretare host diversi.
  if (url.username || url.password) {
    throw new SsrfBlockedError(
      'Le credenziali nell’URL non sono consentite.',
      rawUrl,
      'credentials_in_url',
    );
  }

  // --- 3. Porta -----------------------------------------------------------
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;

  const allowedPorts = new Set([
    ...ALLOWED_PORTS,
    ...(options.extraAllowedPorts ?? []),
  ]);

  if (!allowedPorts.has(port)) {
    throw new SsrfBlockedError(
      `Porta non consentita: ${port}.`,
      rawUrl,
      'port',
    );
  }

  // --- 4. Hostname --------------------------------------------------------
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new SsrfBlockedError(
      `Hostname non consentito: ${hostname}.`,
      rawUrl,
      'blocked_hostname',
    );
  }

  // Se l'host è già un IP letterale, lo controlliamo subito senza DNS.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfBlockedError(
        `L’indirizzo ${hostname} è privato o riservato.`,
        rawUrl,
        'private_ip',
      );
    }
    return url;
  }

  // --- 5. Risoluzione DNS -------------------------------------------------
  // Il controllo che conta davvero: un dominio pubblico può risolvere a un IP
  // interno, e nessun controllo testuale se ne accorgerebbe.
  if (options.skipDnsResolution) return url;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new SsrfBlockedError(
      `Impossibile risolvere l’host ${hostname}.`,
      rawUrl,
      'dns_failure',
    );
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError(
      `Nessun indirizzo per ${hostname}.`,
      rawUrl,
      'dns_empty',
    );
  }

  // TUTTI gli indirizzi devono essere pubblici. Se un dominio risolve sia a un
  // IP pubblico sia a uno privato, un retry potrebbe colpire quello privato.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfBlockedError(
        `${hostname} risolve a un indirizzo privato (${address}).`,
        rawUrl,
        'private_ip_resolved',
      );
    }
  }

  return url;
}

/**
 * `fetch` con validazione SSRF, timeout e limite ai redirect.
 *
 * `redirect: 'manual'` è essenziale: seguire i redirect automaticamente
 * annullerebbe la validazione, perché un URL pubblico può reindirizzare a
 * `http://169.254.169.254`. Ogni salto viene rivalidato.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SsrfGuardOptions & { timeoutMs?: number; maxRedirects?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 3;

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertSafeUrl(currentUrl, options);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(validated.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Non è un redirect: risposta finale.
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) return response;

    // Risolve i redirect relativi rispetto all'URL corrente, poi rivalida.
    currentUrl = new URL(location, validated).toString();
  }

  throw new SsrfBlockedError(
    `Troppi redirect (oltre ${maxRedirects}).`,
    rawUrl,
    'too_many_redirects',
  );
}
