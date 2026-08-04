import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * CIFRATURA DELLE CREDENZIALI CMS — AES-256-GCM
 *
 * Le credenziali dei CMS dei clienti (token WordPress, chiavi Webflow, API
 * Shopify) sono l'asset più sensibile della piattaforma: con quelle si scrive
 * sul sito di qualcun altro.
 *
 * SCELTA DELL'ALGORITMO: GCM e non CBC. GCM è autenticato — produce un tag che
 * rende la manomissione del ciphertext rilevabile. Con CBC un attaccante con
 * accesso in scrittura al database potrebbe alterare i byte cifrati e ottenere
 * un plaintext modificato senza che nessuno se ne accorga.
 *
 * LA CHIAVE VIVE SOLO NEL WORKER. `docker-compose.yml` passa
 * CREDENTIALS_ENCRYPTION_KEY al servizio `worker` e deliberatamente NON al
 * servizio `web`: anche compromettendo l'app web non si decifra nulla.
 *
 * ROTAZIONE: ogni riga porta `credentialsKeyVersion`. Per ruotare si aggiunge
 * la nuova chiave, si incrementa la versione, e le righe vecchie restano
 * decifrabili finché non vengono riscritte.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bit: la dimensione raccomandata per GCM
const AUTH_TAG_LENGTH = 16;

export interface EncryptedPayload {
  /** Ciphertext + tag di autenticazione, in base64. */
  ciphertext: string;
  /** Nonce, in base64. Unico per ogni cifratura. */
  iv: string;
  keyVersion: number;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Decodifica e valida una chiave base64.
 * AES-256 richiede esattamente 32 byte: una chiave più corta verrebbe accettata
 * silenziosamente da alcune implementazioni con sicurezza ridotta, quindi la
 * verifichiamo esplicitamente.
 */
function decodeKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, 'base64');
  } catch {
    throw new CryptoError('La chiave di cifratura non è base64 valido.');
  }

  if (key.length !== 32) {
    throw new CryptoError(
      `La chiave di cifratura deve essere di 32 byte (256 bit), trovati ${key.length}. ` +
        'Genera con: openssl rand -base64 32',
    );
  }

  return key;
}

export interface CryptoConfig {
  /** Chiave corrente, in base64. */
  key: string;
  /** Versione della chiave corrente. */
  keyVersion: number;
  /**
   * Chiavi precedenti, indicizzate per versione. Servono a decifrare le righe
   * scritte prima di una rotazione.
   */
  previousKeys?: Record<number, string>;
}

export function createCredentialsCipher(config: CryptoConfig) {
  const currentKey = decodeKey(config.key);

  const keysByVersion = new Map<number, Buffer>();
  keysByVersion.set(config.keyVersion, currentKey);

  for (const [version, base64] of Object.entries(config.previousKeys ?? {})) {
    keysByVersion.set(Number(version), decodeKey(base64));
  }

  return {
    /**
     * Cifra un oggetto di credenziali.
     * L'IV è casuale a ogni chiamata: cifrare due volte lo stesso valore
     * produce ciphertext diversi, così un osservatore del database non può
     * dedurre che due integrazioni condividono le stesse credenziali.
     */
    encrypt(credentials: Record<string, unknown>): EncryptedPayload {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, currentKey, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });

      const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
      const encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      return {
        // Tag in coda al ciphertext: un solo campo da conservare.
        ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
        iv: iv.toString('base64'),
        keyVersion: config.keyVersion,
      };
    },

    /**
     * Decifra. Se il tag di autenticazione non corrisponde, `final()` lancia:
     * significa che il ciphertext è stato alterato o che la chiave è sbagliata.
     * In entrambi i casi non restituiamo dati parziali.
     */
    decrypt<T = Record<string, unknown>>(payload: EncryptedPayload): T {
      const key = keysByVersion.get(payload.keyVersion);
      if (!key) {
        throw new CryptoError(
          `Chiave di versione ${payload.keyVersion} non disponibile. ` +
            'Le credenziali cifrate con una chiave persa non sono recuperabili.',
        );
      }

      const raw = Buffer.from(payload.ciphertext, 'base64');
      if (raw.length <= AUTH_TAG_LENGTH) {
        throw new CryptoError('Ciphertext troppo corto o corrotto.');
      }

      const encrypted = raw.subarray(0, raw.length - AUTH_TAG_LENGTH);
      const authTag = raw.subarray(raw.length - AUTH_TAG_LENGTH);

      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(payload.iv, 'base64'),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAuthTag(authTag);

      let plaintext: Buffer;
      try {
        plaintext = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]);
      } catch {
        throw new CryptoError(
          'Decifratura fallita: credenziali manomesse o chiave errata.',
        );
      }

      return JSON.parse(plaintext.toString('utf8')) as T;
    },
  };
}

export type CredentialsCipher = ReturnType<typeof createCredentialsCipher>;

/** Costruisce il cifratore dalle variabili d'ambiente del worker. */
export function createCipherFromEnv(): CredentialsCipher {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!key) {
    throw new CryptoError(
      'CREDENTIALS_ENCRYPTION_KEY non è configurata. Questo processo non può ' +
        'gestire le credenziali dei CMS.',
    );
  }

  return createCredentialsCipher({
    key,
    keyVersion: Number(process.env.CREDENTIALS_KEY_VERSION ?? 1),
  });
}

/**
 * Confronto a tempo costante per firme e token.
 *
 * `===` su stringhe termina al primo byte diverso: la differenza di tempo è
 * misurabile e permette di ricostruire un segreto byte per byte. Rilevante per
 * la verifica delle firme dei webhook.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // `timingSafeEqual` richiede lunghezze uguali: la disuguaglianza di lunghezza
  // non è un segreto, quindi uscire subito qui è accettabile.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
