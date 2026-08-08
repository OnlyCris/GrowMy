'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  confirmGscPropertyAction,
  disconnectGscAction,
  runPlannerNowAction,
  syncGscNowAction,
} from '@/actions/analytics.actions';
import { AutoRefresh } from '@/components/shared/auto-refresh';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { formatRelativeTime } from '@/lib/utils';

/**
 * STATO DELLA CONNESSIONE A SEARCH CONSOLE.
 *
 * Tre situazioni distinte, non due, ed è la ragione per cui questo componente
 * esiste invece di un bottone:
 *
 *  1. Non collegato → invito a collegare.
 *  2. Consenso ottenuto, property da scegliere → l'elenco delle property.
 *     È lo stato che esiste solo per pochi secondi ma senza il quale l'utente
 *     con più siti non ha modo di dire quale intende collegare.
 *  3. Collegato → stato del sync e le azioni manuali.
 */

export interface GscSiteOption {
  siteUrl: string;
  permissionLevel: string;
}

export interface ConnectionState {
  siteUrl: string;
  connectedEmail: string | null;
  lastSyncedAt: Date | null;
  lastSyncedDate: string | null;
  lastSyncError: string | null;
}

/** Messaggi per i codici che il callback OAuth può rimandare in query string. */
const ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    'Collegamento annullato. Nessun dato è stato condiviso con la piattaforma.',
  no_sites:
    'Questo account Google non ha nessuna property Search Console verificata. ' +
    'Verifica di aver autorizzato l’account giusto, oppure verifica prima il sito su Search Console.',
  no_refresh_token:
    'Google non ha rilasciato un permesso duraturo. Revoca l’accesso alla piattaforma ' +
    'dalle impostazioni del tuo account Google e riprova.',
  GSC_SCOPE_DENIED:
    'Il permesso di lettura su Search Console non è stato concesso. ' +
    'Riprova lasciando selezionata la voce relativa a Search Console.',
  GSC_AUTH_FAILED:
    'Google ha rifiutato l’accesso. Verifica che l’account abbia accesso alla property.',
  invalid_state:
    'La richiesta di collegamento è scaduta. Riprova dall’inizio.',
  consent_failed: 'Il collegamento non è andato a buon fine. Riprova.',
  start_failed: 'Impossibile avviare il collegamento. Riprova fra poco.',
  unexpected: 'Errore imprevisto durante il collegamento. Riprova fra poco.',
};

export function GscConnectionPanel({
  productId,
  orgSlug,
  connection,
  /** Valorizzati quando si torna dal consenso e resta da scegliere la property. */
  pendingToken,
  pendingSites,
  pendingEmail,
  errorCode,
}: {
  productId: string;
  orgSlug: string;
  connection: ConnectionState | null;
  pendingToken?: string | null;
  pendingSites?: GscSiteOption[];
  pendingEmail?: string | null;
  errorCode?: string | null;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(
    errorCode ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.unexpected) : null,
  );
  const [isPending, startTransition] = React.useTransition();
  const [syncStarted, setSyncStarted] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [selectedSite, setSelectedSite] = React.useState(
    () => pendingSites?.[0]?.siteUrl ?? '',
  );

  function handleConfirm() {
    if (!pendingToken || !selectedSite) return;
    setError(null);

    startTransition(async () => {
      const result = await confirmGscPropertyAction({
        productId,
        connectionToken: pendingToken,
        siteUrl: selectedSite,
      });

      if (result.ok) {
        setSyncStarted(true);
        // Toglie `?gsc_connect=` dall'URL: il token è consumato, e lasciarlo
        // nella barra degli indirizzi lo espone alla cronologia e a una
        // ricondivisione accidentale del link.
        router.replace(`/${orgSlug}/products/${productId}/analytics`);
      } else {
        setError(result.message);
      }
    });
  }

  function handleSync() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await syncGscNowAction({ productId });
      if (result.ok) {
        setSyncStarted(true);
        setNotice('Sincronizzazione avviata: i dati compariranno qui appena pronti.');
      } else {
        setError(result.message);
      }
    });
  }

  function handleRunPlanner() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await runPlannerNowAction({ productId });
      if (result.ok) {
        setSyncStarted(true);
        setNotice('Ricalcolo avviato: le nuove decisioni compariranno qui sotto.');
      } else {
        setError(result.message);
      }
    });
  }

  function handleDisconnect() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await disconnectGscAction({ productId });
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  // --- Stato 2: scelta della property --------------------------------------
  if (pendingToken && pendingSites && pendingSites.length > 0) {
    return (
      <section className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-accent-400 bg-accent-50 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">
            Scegli la property da collegare
          </h2>
          <p className="text-xs text-foreground-muted">
            {pendingEmail
              ? `Account collegato: ${pendingEmail}. `
              : ''}
            Seleziona il sito di cui vuoi importare i dati di ricerca.
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Property disponibili</legend>
          {pendingSites.map((site) => (
            <label
              key={site.siteUrl}
              className="flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2"
            >
              <input
                type="radio"
                name="gsc-site"
                value={site.siteUrl}
                checked={selectedSite === site.siteUrl}
                onChange={(event) => setSelectedSite(event.target.value)}
                className="size-4"
              />
              <span className="flex flex-col">
                <span className="text-sm text-foreground">{site.siteUrl}</span>
                {site.permissionLevel === 'siteRestrictedUser' ? (
                  <span className="text-xs text-foreground-muted">
                    Accesso limitato: alcuni dati potrebbero non essere disponibili.
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>

        <FormError messages={error} />

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            isLoading={isPending}
            loadingLabel="Collegamento in corso"
            onClick={handleConfirm}
            disabled={!selectedSite}
          >
            Collega questa property
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => router.replace(`/${orgSlug}/products/${productId}/analytics`)}
          >
            Annulla
          </Button>
        </div>
      </section>
    );
  }

  // --- Stato 1: non collegato ----------------------------------------------
  if (!connection) {
    return (
      <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-muted p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">
            Collega Google Search Console
          </h2>
          <p className="text-xs text-foreground-muted">
            Senza dati reali il piano editoriale si basa solo su stime. Con Search
            Console collegata la piattaforma vede su quali ricerche il sito compare
            davvero, e usa quei numeri per scegliere cosa scrivere e cosa aggiornare.
          </p>
        </div>

        <FormError messages={error} />

        <div>
          <Button asChild size="sm">
            <a
              href={`/api/oauth/gsc/start?productId=${encodeURIComponent(productId)}&orgSlug=${encodeURIComponent(orgSlug)}`}
            >
              Collega Search Console
            </a>
          </Button>
        </div>

        <p className="text-xs text-foreground-muted">
          Richiediamo il permesso di sola lettura: la piattaforma non può modificare
          nulla sul tuo account Search Console.
        </p>
      </section>
    );
  }

  // --- Stato 3: collegato ---------------------------------------------------
  const neverSynced = connection.lastSyncedAt === null;

  return (
    <section className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-surface p-4">
      {/* Il primo import parte subito dopo il collegamento e dura qualche
          decina di secondi: senza aggiornamento automatico l'utente resta su
          una pagina vuota senza sapere se sta succedendo qualcosa. */}
      <AutoRefresh enabled={syncStarted || neverSynced} />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {connection.siteUrl}
          </span>
          <span className="text-xs text-foreground-muted">
            {connection.connectedEmail
              ? `Collegata con ${connection.connectedEmail}. `
              : ''}
            {neverSynced
              ? 'Primo import in corso — la pagina si aggiorna da sola.'
              : `Ultimo aggiornamento ${formatRelativeTime(connection.lastSyncedAt)}${
                  connection.lastSyncedDate
                    ? `, dati fino al ${connection.lastSyncedDate}`
                    : ''
                }.`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            isLoading={isPending}
            loadingLabel="Avvio in corso"
            onClick={handleSync}
          >
            Aggiorna dati
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            isLoading={isPending}
            loadingLabel="Avvio in corso"
            onClick={handleRunPlanner}
          >
            Ricalcola priorità
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            isLoading={isPending}
            loadingLabel="…"
            onClick={handleDisconnect}
          >
            Scollega
          </Button>
        </div>
      </div>

      {/* L'errore dell'ultimo sync viene dal database, non da questa
          interazione: va mostrato anche quando l'utente non ha appena
          cliccato nulla, altrimenti una connessione rotta resta invisibile
          fino al prossimo tentativo manuale. */}
      {connection.lastSyncError ? (
        <p className="rounded-[var(--radius-md)] bg-danger-100 px-3 py-2 text-sm text-danger-700">
          {connection.lastSyncError}
        </p>
      ) : null}

      {notice ? <p className="text-xs text-foreground-muted">{notice}</p> : null}
      <FormError messages={error} />
    </section>
  );
}
