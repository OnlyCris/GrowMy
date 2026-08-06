import Link from 'next/link';
import { CheckCircle2, Gauge, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * LANDING — mostrata sulla root `/` a chi non ha una sessione.
 *
 * Non un route group `(marketing)` separato: collideerebbe con `page.tsx`,
 * che possiede già `/`. Questo componente è la sola cosa che quel file
 * renderizza per i visitatori anonimi.
 *
 * Copy: riusa la promessa già scritta in `app/layout.tsx` (`metadata.description`)
 * invece di inventarne una nuova. I tre punti sotto la piega ricalcano i tre
 * "upgrade" strutturali del prodotto (vedi `docs/ARCHITECTURE.md`): revisione
 * umana, pianificazione sui dati reali di Search Console, pipeline osservabile.
 *
 * REGOLA DI DESIGN (docs/DESIGN.md): le CTA sono `primary`/`outline`, MAI
 * `accent` — l'ambra è riservata alle decisioni umane in sospeso, non
 * disponibile su una landing dove non ce n'è ancora nessuna.
 */
export function MarketingLanding() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <span className="text-base font-semibold tracking-tight text-foreground">
            GrowMy
          </span>
          <nav className="flex items-center gap-2" aria-label="Account">
            <Button asChild variant="ghost" size="sm">
              <Link href="/signin">Accedi</Link>
            </Button>
            <Button asChild variant="primary" size="sm">
              <Link href="/signup">Inizia gratis</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto w-full max-w-3xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Traffico organico in autopilota
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-foreground-muted">
            Ricerca keyword, stesura e pubblicazione automatiche. Con il
            controllo umano dove serve davvero.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/signup">Inizia gratis</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/signin">Accedi</Link>
            </Button>
          </div>
        </section>

        <section className="border-t border-border bg-surface-muted">
          <div className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-16 sm:grid-cols-3 sm:px-6">
            <article className="flex flex-col gap-3">
              <ShieldCheck className="size-6 text-foreground-muted" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Revisione umana dove conta
              </h2>
              <p className="text-sm leading-relaxed text-foreground-muted">
                Ogni angolo editoriale e ogni bozza passano da una coda di
                approvazione prima di essere scritti o pubblicati. Il resto
                della pipeline lavora da solo.
              </p>
            </article>

            <article className="flex flex-col gap-3">
              <Gauge className="size-6 text-foreground-muted" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Pianificazione guidata dai dati
              </h2>
              <p className="text-sm leading-relaxed text-foreground-muted">
                Le prossime keyword e i refresh nascono dalle metriche reali di
                Search Console, non da un calendario editoriale fisso.
              </p>
            </article>

            <article className="flex flex-col gap-3">
              <CheckCircle2 className="size-6 text-foreground-muted" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Niente lavoro nel buio
              </h2>
              <p className="text-sm leading-relaxed text-foreground-muted">
                Ogni generazione è un job tracciabile: sai sempre a che punto
                è, cosa è andato storto e perché — mai solo uno spinner.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 text-xs text-foreground-subtle sm:px-6">
          © {new Date().getFullYear()} GrowMy
        </div>
      </footer>
    </div>
  );
}
