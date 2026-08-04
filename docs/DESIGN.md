# GrowMy — Direzione di design

## Il principio: **il colore significa "devi decidere"**

Outrank usa il viola ovunque: header, bottoni, badge, illustrazioni. Il risultato è
che nulla emerge, perché tutto grida. In un prodotto la cui promessa è *"lavora
mentre dormi"*, l'interfaccia dovrebbe essere silenziosa per default e diventare
rumorosa **solo** quando serve un umano.

Da qui la regola che governa l'intero design system:

> La UI è monocroma. L'accento è riservato esclusivamente alle azioni che
> richiedono una decisione umana.

Un articolo in generazione è grigio. Un articolo che aspetta la tua approvazione è
ambra. Se apri la dashboard e non vedi ambra, non devi fare niente — e lo capisci
in mezzo secondo, senza leggere una parola. Questo è l'UPGRADE #1 tradotto in
linguaggio visivo, ed è ciò che rende l'interfaccia scansionabile invece che
decorativa.

## Palette

**Base — stone (neutro caldo).** Il grigio freddo è la scelta di default di ogni
dashboard SaaS. Lo stone ha una punta di rosso che rende il testo lungo più
leggibile e l'insieme meno clinico: importante in un prodotto dove si legge
molta prosa.

**Accento — ambra `oklch(0.75 0.15 70)`.** Non è decorativo. Compare su:
approvazione richiesta, credito in esaurimento, integrazione da riparare. Nient'altro.

**Colori funzionali — desaturati.** Verde, rosso e blu esistono solo negli stati
(`published`, `failed`, `info`) e sono volutamente smorzati, così non competono
con l'ambra. Un errore è importante, ma un errore è *già successo*: non richiede
la stessa urgenza di una decisione ancora aperta.

Tutte le coppie testo/sfondo raggiungono almeno **4.5:1** (WCAG AA), i testi grandi
almeno 3:1, e nessuna informazione è veicolata dal solo colore — ogni stato ha
anche un'icona e un'etichetta testuale.

## Tipografia

- **Inter** per l'interfaccia. Tabular numerals attivi su metriche e tabelle: le
  cifre non ballano quando i dati si aggiornano in tempo reale.
- **Source Serif 4** per il corpo dell'articolo nell'editor. È il segnale più
  economico e più efficace per dire *"qui stai leggendo, non stai amministrando"*,
  e rende molto più facile accorgersi che una frase suona male.
- Scala tipografica su 1.25 con `clamp()`: fluida, senza breakpoint sulla dimensione.

## Movimento

Framer Motion applicato con parsimonia, e sempre con uno scopo:

- **Entrata in lista**: stagger di 40ms, translateY 8px. Comunica l'ordine di lettura.
- **Cambio di stato**: `layoutId` condiviso, così una card che passa da
  "in revisione" a "approvato" **si sposta** invece di sparire e riapparire.
  L'utente non perde il filo di cosa è successo.
- **Progresso della pipeline**: barra a segmenti, non spinner. Uno spinner dice
  "aspetta"; una barra a segmenti dice "sei al passo 3 di 5", che è l'informazione
  che serve davvero quando un lavoro dura 6 minuti.

Tutto rispetta `prefers-reduced-motion`: le transizioni diventano dissolvenze da
1ms, mai eliminate del tutto (altrimenti i cambi di stato risultano bruschi).

## Densità

Due modalità sulla stessa griglia: **comoda** per l'editor e la revisione (dove si
legge), **compatta** per tabelle e planner (dove si scansiona). Non è una
preferenza utente da settings: è una scelta per-vista, decisa da cosa serve fare
in quella schermata.

## Accessibilità — non negoziabile

- Ogni interattivo raggiungibile da tastiera, focus ring visibile a 2px con offset.
- Le azioni di approvazione hanno scorciatoie (`A` approva, `R` rifiuta, `J`/`K`
  navigano la coda): chi revisiona 30 articoli al mese non deve usare il mouse.
- Live region `aria-live="polite"` sui cambi di stato asincroni, così uno screen
  reader annuncia "articolo approvato" senza che l'utente debba andarlo a cercare.
- Nessun `div` cliccabile. Bottoni sono bottoni, link sono link.
