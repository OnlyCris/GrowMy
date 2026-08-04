import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge di classi Tailwind con risoluzione dei conflitti.
 * `clsx` gestisce i condizionali, `twMerge` garantisce che l'ultima classe di una
 * stessa famiglia vinca (`px-2 px-4` -> `px-4`), che è ciò che rende sicuro
 * accettare `className` come prop di override su ogni componente.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formatta una durata in millisecondi in forma leggibile e compatta.
 * Usata nelle timeline dei job, dove `6m 12s` è più utile di `372000`.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Tempo relativo localizzato ("3 ore fa", "fra 2 giorni").
 * Usa `Intl.RelativeTimeFormat`: niente date-fns nel bundle client per una
 * funzionalità che la piattaforma offre nativamente.
 */
export function formatRelativeTime(
  date: Date | string | null | undefined,
  locale = 'it-IT',
): string {
  if (!date) return '—';
  const target = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(target.getTime())) return '—';

  const deltaSeconds = (target.getTime() - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const thresholds: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];

  for (const [unit, secondsInUnit] of thresholds) {
    if (Math.abs(deltaSeconds) >= secondsInUnit || unit === 'second') {
      return formatter.format(Math.round(deltaSeconds / secondsInUnit), unit);
    }
  }
  return formatter.format(0, 'second');
}

/**
 * Ore rimanenti prima che scatti l'auto-approvazione per timeout (UPGRADE #1).
 * Ritorna `null` se il prodotto non ha timeout configurato (attesa indefinita).
 */
export function hoursUntilAutoApproval(
  waitingSince: Date | string,
  timeoutHours: number | null,
): number | null {
  if (timeoutHours == null) return null;
  const since =
    typeof waitingSince === 'string' ? new Date(waitingSince) : waitingSince;
  const deadline = since.getTime() + timeoutHours * 3_600_000;
  return Math.max(0, (deadline - Date.now()) / 3_600_000);
}

/** Tronca preservando le parole intere: evita il taglio a metà sillaba. */
export function truncateWords(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : maxChars).trimEnd()}…`;
}
