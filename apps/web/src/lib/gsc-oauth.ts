import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '@growmy/env';
import type { GscSite } from '@growmy/integrations';

import { getRedis } from './redis';

/**
 * FLUSSO OAuth VERSO SEARCH CONSOLE — le due parti che vivono lato web.
 *
 * 1. `state` firmato: protegge il giro di andata e ritorno dal CSRF.
 * 2. Custodia temporanea su Redis: tiene la connessione a metà strada mentre
 *    l'utente sceglie quale property collegare.
 *
 * PERCHÉ SERVE UNA CUSTODIA TEMPORANEA
 *
 * Google restituisce il refresh token nell'istante del callback, ma in quel
 * momento non sappiamo ancora QUALE property l'utente vuole collegare: un
 * account può averne decine, e `gsc_connections.site_url` è NOT NULL. Fra il
 * callback e la scelta dell'utente c'è quindi un intervallo in cui il token
 * esiste e non ha ancora una casa definitiva.
 *
 * Tre opzioni, una sola accettabile:
 *  - Rimandarlo al browser in un campo nascosto: lo esporrebbe alla cronologia,
 *    ai log del proxy e a qualunque estensione. Escluso.
 *  - Scriverlo subito su `gsc_connections` con una property provvisoria: il
 *    processo web non ha `CREDENTIALS_ENCRYPTION_KEY` (vive solo nel worker,
 *    vedi `packages/integrations/src/crypto.ts`) e finirebbe in chiaro nel
 *    database, che è precisamente ciò che quella separazione impedisce.
 *  - Redis con TTL breve, chiave legata all'utente: il token resta in memoria
 *    per pochi minuti, non tocca né il browser né lo storage persistente, e
 *    scade da solo se l'utente abbandona a metà.
 *
 * Resta un compromesso — un segreto in chiaro, per quanto brevemente — ed è lo
 * stesso già accettato per le credenziali CMS in `integration_connect`. La
 * finestra qui è di quindici minuti e la chiave è monouso.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_SECONDS = 15 * 60;
const PENDING_KEY_PREFIX = 'gsc:pending:';

/** URI di reindirizzamento. Deve combaciare al carattere con quello registrato
 *  in Google Cloud Console: Google confronta la stringa esatta, barra finale
 *  inclusa, e un disallineamento produce `redirect_uri_mismatch`. */
export function gscRedirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL}/api/oauth/gsc/callback`;
}

// ---------------------------------------------------------------------------
// 1. State firmato
// ---------------------------------------------------------------------------

export interface GscOAuthState {
  productId: string;
  orgSlug: string;
  userId: string;
  /** Scadenza in millisecondi epoch. */
  exp: number;
  /** Rende ogni state unico anche a parità di tutto il resto. */
  nonce: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payload: string): string {
  return base64url(createHmac('sha256', env.CSRF_SECRET).update(payload).digest());
}

/**
 * Costruisce lo `state` da passare a Google.
 *
 * Contiene l'identità dell'utente e il prodotto, firmati: al ritorno sappiamo
 * che la richiesta è partita da noi e per chi. Senza firma, un attaccante
 * potrebbe indurre la vittima a completare un flusso OAuth che collega
 * l'account Google dell'attaccante al prodotto della vittima — o il contrario,
 * dirottando i dati Search Console della vittima su un prodotto altrui.
 */
export function signGscState(state: Omit<GscOAuthState, 'exp' | 'nonce'>): string {
  const payload: GscOAuthState = {
    ...state,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(9).toString('base64url'),
  };

  const encoded = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${sign(encoded)}`;
}

/** Verifica firma e scadenza. `null` per qualunque anomalia, senza distinguerle. */
export function verifyGscState(raw: string | null): GscOAuthState | null {
  if (!raw) return null;

  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return null;

  const encoded = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  const expected = Buffer.from(sign(encoded), 'utf8');
  const received = Buffer.from(signature, 'utf8');

  // `timingSafeEqual` pretende lunghezze uguali: la disuguaglianza di lunghezza
  // non è un segreto, uscire subito qui non aggiunge informazione sfruttabile.
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;

  try {
    const state = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as GscOAuthState;

    if (typeof state.exp !== 'number' || state.exp < Date.now()) return null;
    if (!state.productId || !state.userId || !state.orgSlug) return null;

    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Connessione in attesa della scelta della property
// ---------------------------------------------------------------------------

export interface PendingGscConnection {
  productId: string;
  userId: string;
  refreshToken: string;
  connectedEmail: string | null;
  /** Property leggibili dall'account, per la scelta in UI. */
  sites: GscSite[];
}

function pendingKey(token: string): string {
  return `${PENDING_KEY_PREFIX}${token}`;
}

/** Deposita la connessione a metà strada. Ritorna il token opaco da passare in URL. */
export async function storePendingGscConnection(
  connection: PendingGscConnection,
): Promise<string> {
  const token = randomBytes(24).toString('base64url');

  await getRedis().set(
    pendingKey(token),
    JSON.stringify(connection),
    'EX',
    PENDING_TTL_SECONDS,
  );

  return token;
}

/**
 * Rilegge la connessione in attesa.
 *
 * `userId` non è un parametro di comodo: il token viaggia in un URL, che finisce
 * nella cronologia e nel campo `Referer`. Legare la lettura all'utente
 * autenticato fa sì che un token trapelato non basti a nessun altro per
 * completare il collegamento.
 */
export async function readPendingGscConnection(
  token: string,
  userId: string,
): Promise<PendingGscConnection | null> {
  const raw = await getRedis().get(pendingKey(token));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingGscConnection;
    if (parsed.userId !== userId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Consuma il token. Chiamato appena il job di connessione è stato accodato. */
export async function deletePendingGscConnection(token: string): Promise<void> {
  await getRedis().del(pendingKey(token));
}
