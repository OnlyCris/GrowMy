/**
 * Messaggio di errore di un campo (o dell'intero form). `role="alert"` +
 * `aria-live="polite"`: uno screen reader lo annuncia quando compare, senza
 * che l'utente debba andarlo a cercare — stesso principio dei cambi di stato
 * asincroni descritto in docs/DESIGN.md.
 *
 * `text-danger-700`, non `-500`: `globals.css` usa già `-700` per il testo su
 * superficie chiara (`.diff-removed`) — `-500`/`-100` restano per bordi/sfondi.
 */
export function FormError({
  messages,
  id,
}: {
  messages?: string | string[] | null;
  id?: string;
}) {
  if (!messages || messages.length === 0) return null;

  const text = Array.isArray(messages) ? messages.join(' ') : messages;

  return (
    <p id={id} role="alert" aria-live="polite" className="text-xs text-danger-700">
      {text}
    </p>
  );
}
