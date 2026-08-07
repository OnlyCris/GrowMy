/**
 * IGIENE DEI LINK INTERNI GENERATI.
 *
 * Il modello riceve un elenco di slug REALI da linkare (`internalLinkTargets`
 * nel brief) ma nulla impedisce che nel testo finito compaia uno slug diverso
 * — riformulato, storpiato, o del tutto inventato quando la prosa "sente" il
 * bisogno di un rimando che non gli è mai stato dato. Il risultato è un link
 * che punta a un articolo che non esiste: scoperto in produzione, non solo
 * teorico.
 *
 * Non è compito del prompt engineering risolverlo fino in fondo — nessuna
 * istruzione garantisce che un LLM non generi mai testo fuori dai dati
 * forniti. Questa funzione è il controllo che conta: dopo la generazione,
 * prima del salvataggio, ogni link relativo viene verificato contro l'elenco
 * REALE degli slug consentiti. Chi non supera la verifica perde l'hyperlink
 * ma non il testo — il lettore vede comunque la frase, solo senza un link
 * rotto.
 */
export function sanitizeInternalLinks(
  markdown: string,
  validSlugs: ReadonlySet<string>,
): string {
  // `(?<!!)` esclude le immagini (`![alt](/path)`), che non sono link di
  // navigazione e non vanno toccate. Il path può portare `#ancora` o
  // `?query`: solo la parte prima conta come slug da verificare.
  return markdown.replace(
    /(?<!!)\[([^\]]+)\]\(\/([^)]*)\)/g,
    (match, text: string, path: string) => {
      const slug = path.split(/[?#]/)[0];
      return validSlugs.has(slug) ? match : text;
    },
  );
}
