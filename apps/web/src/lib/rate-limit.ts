import { env } from '@growmy/env';
import { Redis } from 'ioredis';

/**
 * RATE LIMITING — finestra scorrevole su Redis.
 *
 * Algoritmo: sliding window log implementato con un sorted set. Ogni richiesta
 * inserisce un membro con score = timestamp; le richieste fuori finestra vengono
 * rimosse; il conteggio residuo è il consumo reale.
 *
 * Perché non un token bucket a contatore fisso: un contatore che si azzera allo
 * scoccare del minuto consente il doppio del limite a cavallo della finestra
 * (59 richieste a :59, altre 59 a :00). Per gli endpoint di autenticazione
 * questa è esattamente la finestra che un attaccante sfrutta.
 *
 * L'intera sequenza è uno script Lua: Redis lo esegue atomicamente, quindi
 * richieste concorrenti non possono superare il limite insieme.
 */

const globalForRedis = globalThis as unknown as { __growmyRedis?: Redis };

function getRedis(): Redis {
  globalForRedis.__growmyRedis ??= new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
  return globalForRedis.__growmyRedis;
}

/**
 * KEYS[1] = chiave del sorted set
 * ARGV[1] = timestamp corrente (ms)
 * ARGV[2] = ampiezza finestra (ms)
 * ARGV[3] = limite massimo
 * ARGV[4] = membro univoco della richiesta
 *
 * Ritorna { consumo, timestamp della richiesta più vecchia in finestra }.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
end

redis.call('PEXPIRE', key, window)

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = 0
if oldest[2] then oldestScore = tonumber(oldest[2]) end

return { count, oldestScore }
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Millisecondi da attendere prima di ritentare. 0 se consentito. */
  retryAfterMs: number;
}

/** Configurazione dei limiti per scope. Un solo posto da guardare. */
export const RATE_LIMITS = {
  'auth.signin': { limit: 5, windowMs: 60_000 },
  'auth.signup': { limit: 3, windowMs: 3_600_000 },
  'onboarding.create-organization': { limit: 5, windowMs: 3_600_000 },
  'invite.accept': { limit: 10, windowMs: 3_600_000 },
  'review.approve': { limit: 60, windowMs: 60_000 },
  'review.save': { limit: 60, windowMs: 60_000 },
  'review.reject': { limit: 30, windowMs: 60_000 },
  'review.rewrite': { limit: 30, windowMs: 60_000 },
  'keywords.generate': { limit: 5, windowMs: 3_600_000 },
  'articles.generate': { limit: 10, windowMs: 3_600_000 },
  'integration.connect': { limit: 10, windowMs: 3_600_000 },
  'planner.run': { limit: 2, windowMs: 3_600_000 },
  'api.default': { limit: 120, windowMs: 60_000 },
} as const;

export type RateLimitScope = keyof typeof RATE_LIMITS;

/**
 * Verifica e consuma una unità di quota.
 *
 * `subject` deve identificare il soggetto in modo stabile: `user:<uuid>` per gli
 * utenti autenticati, `ip:<prefisso>` per quelli anonimi. Usare l'IP grezzo per
 * un utente autenticato è sbagliato: penalizzerebbe tutti i colleghi dietro lo
 * stesso NAT aziendale.
 */
export async function checkRateLimit(
  scope: RateLimitScope,
  subject: string,
): Promise<RateLimitResult> {
  const { limit, windowMs } = RATE_LIMITS[scope];
  const key = `rl:${scope}:${subject}`;
  const now = Date.now();

  try {
    const [count, oldestScore] = (await getRedis().eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      String(now),
      String(windowMs),
      String(limit),
      `${now}-${Math.random().toString(36).slice(2, 10)}`,
    )) as [number, number];

    const allowed = count <= limit;

    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - count),
      // Il prossimo slot si libera quando la richiesta più vecchia esce dalla finestra.
      retryAfterMs: allowed ? 0 : Math.max(0, oldestScore + windowMs - now),
    };
  } catch {
    /**
     * FAIL-OPEN, deliberato e circoscritto.
     *
     * Se Redis è irraggiungibile, bloccare tutto renderebbe l'indisponibilità
     * della cache un'indisponibilità totale del prodotto. Consentiamo la
     * richiesta, ma le azioni davvero sensibili (login, pagamenti) hanno una
     * seconda linea di difesa persistente su `rate_limit_violations`, che non
     * dipende da Redis.
     */
    return { allowed: true, limit, remaining: limit, retryAfterMs: 0 };
  }
}

/**
 * Estrae un identificatore di soggetto anonimo dagli header, con l'IP troncato.
 *
 * Il troncamento (/24 IPv4, /48 IPv6) riduce l'impronta di dato personale
 * mantenendo il rate limiting efficace: un attaccante che cambia l'ultimo
 * ottetto resta nello stesso bucket.
 */
export function anonymousSubjectFromHeaders(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  const raw = (forwarded?.split(',')[0] ?? headers.get('x-real-ip') ?? '').trim();

  if (!raw) return 'ip:unknown';

  if (raw.includes(':')) {
    // IPv6 -> primi 3 gruppi (/48).
    return `ip:${raw.split(':').slice(0, 3).join(':')}::`;
  }

  const octets = raw.split('.');
  if (octets.length !== 4) return 'ip:unknown';
  return `ip:${octets[0]}.${octets[1]}.${octets[2]}.0`;
}

/** Health check per `/api/ready`. */
export async function checkRedisHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
}> {
  const startedAt = performance.now();
  try {
    await getRedis().ping();
    return { healthy: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { healthy: false, latencyMs: Math.round(performance.now() - startedAt) };
  }
}
