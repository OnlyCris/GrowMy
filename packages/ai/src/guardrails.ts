import { countWords } from '@growmy/core';

/**
 * GUARDRAIL SULL'OUTPUT DEL MODELLO
 *
 * Il contenuto generato non va mai pubblicato senza controlli. Qui verifichiamo
 * ciò che si può verificare in modo deterministico, prima che l'articolo
 * raggiunga il CMS di un cliente.
 *
 * Non sostituisce la revisione umana (UPGRADE #1): la precede, e serve a non
 * far arrivare a un umano roba palesemente rotta.
 */

export { countWords };

export interface GuardrailViolation {
  code:
    | 'FORBIDDEN_TOPIC'
    | 'PROMPT_LEAKAGE'
    | 'TOO_SHORT'
    | 'TOO_LONG'
    | 'MISSING_KEYWORD'
    | 'SUSPICIOUS_LINK'
    | 'EMPTY_SECTION';
  /** `error` blocca la pipeline, `warning` la annota e lascia proseguire. */
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Frasi che indicano che il modello ha "rotto il personaggio" e sta parlando
 * delle proprie istruzioni invece di scrivere l'articolo. Sintomo classico di
 * un tentativo di prompt injection andato parzialmente a segno.
 */
const LEAKAGE_PATTERNS = [
  /come (?:modello|intelligenza artificiale|assistente) (?:di linguaggio|AI)/i,
  /as an AI (?:language )?model/i,
  /non posso (?:soddisfare|completare) (?:questa|la tua) richiesta/i,
  /I(?:'m| am) (?:sorry|unable to)/i,
  /(?:le|le mie) istruzioni (?:precedenti|di sistema)/i,
  /system prompt/i,
  /ignora le istruzioni/i,
] as const;

/** Schema di URL che non devono mai finire in un articolo pubblicato. */
const DANGEROUS_URL_SCHEMES = /\b(?:javascript|data|vbscript|file):/i;

export interface GuardrailInput {
  contentMarkdown: string;
  title: string;
  targetKeyword: string;
  forbiddenTopics: string[];
  minWords: number;
  maxWords: number;
}

export function checkGuardrails(input: GuardrailInput): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const text = input.contentMarkdown;
  const lowerText = text.toLowerCase();

  // --- Lunghezza ----------------------------------------------------------
  const wordCount = countWords(text);

  if (wordCount < input.minWords * 0.7) {
    violations.push({
      code: 'TOO_SHORT',
      severity: 'error',
      message: `L'articolo ha ${wordCount} parole, molto sotto le ${input.minWords} richieste.`,
    });
  } else if (wordCount < input.minWords) {
    violations.push({
      code: 'TOO_SHORT',
      severity: 'warning',
      message: `L'articolo ha ${wordCount} parole, sotto le ${input.minWords} richieste.`,
    });
  }

  if (wordCount > input.maxWords * 1.5) {
    violations.push({
      code: 'TOO_LONG',
      severity: 'warning',
      message: `L'articolo ha ${wordCount} parole, ben oltre le ${input.maxWords} previste.`,
    });
  }

  // --- Argomenti vietati --------------------------------------------------
  for (const topic of input.forbiddenTopics) {
    const needle = topic.trim().toLowerCase();
    if (needle.length > 2 && lowerText.includes(needle)) {
      violations.push({
        code: 'FORBIDDEN_TOPIC',
        severity: 'error',
        message: `Il contenuto menziona un argomento vietato dal profilo di brand: "${topic}".`,
      });
    }
  }

  // --- Leakage del prompt -------------------------------------------------
  for (const pattern of LEAKAGE_PATTERNS) {
    if (pattern.test(text)) {
      violations.push({
        code: 'PROMPT_LEAKAGE',
        severity: 'error',
        message:
          'Il testo contiene frasi da assistente AI invece che da articolo: rigenerazione necessaria.',
      });
      break;
    }
  }

  // --- Keyword target -----------------------------------------------------
  const keyword = input.targetKeyword.trim().toLowerCase();
  if (keyword && !lowerText.includes(keyword)) {
    // Le varianti flesse sono legittime: controlliamo anche le singole parole.
    const words = keyword.split(/\s+/).filter((w) => w.length > 3);
    const allPresent =
      words.length > 0 && words.every((w) => lowerText.includes(w));

    if (!allPresent) {
      violations.push({
        code: 'MISSING_KEYWORD',
        severity: 'warning',
        message: `La keyword "${input.targetKeyword}" non compare nel testo.`,
      });
    }
  }

  // --- Link pericolosi ----------------------------------------------------
  if (DANGEROUS_URL_SCHEMES.test(text)) {
    violations.push({
      code: 'SUSPICIOUS_LINK',
      severity: 'error',
      message:
        'Il contenuto contiene URL con schema non consentito (javascript:, data: o simili).',
    });
  }

  // --- Sezioni vuote ------------------------------------------------------
  const emptySections = findEmptySections(text);
  if (emptySections.length > 0) {
    violations.push({
      code: 'EMPTY_SECTION',
      severity: 'warning',
      message: `Sezioni senza contenuto: ${emptySections.join(', ')}.`,
    });
  }

  return violations;
}

export function hasBlockingViolation(
  violations: GuardrailViolation[],
): boolean {
  return violations.some((v) => v.severity === 'error');
}


/** Titoli di sezione seguiti da meno di 20 parole di contenuto. */
function findEmptySections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const empty: string[] = [];

  let currentHeading: string | null = null;
  let buffer: string[] = [];
  let insideFence = false;

  const flush = () => {
    if (currentHeading && countWords(buffer.join(' ')) < 20) {
      empty.push(currentHeading);
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) insideFence = !insideFence;

    const heading = insideFence ? null : /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      currentHeading = heading[2].trim();
      buffer = [];
    } else if (currentHeading) {
      buffer.push(line);
    }
  }
  flush();

  return empty;
}
