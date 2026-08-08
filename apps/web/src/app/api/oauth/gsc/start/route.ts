import { env } from '@growmy/env';
import { buildGscConsentUrl } from '@growmy/integrations';
import { NextResponse } from 'next/server';

import { assertOrgRole, AuthorizationError } from '@/lib/auth/guards';
import { gscRedirectUri, signGscState } from '@/lib/gsc-oauth';
import { logger } from '@/lib/logger';
import { getProductById } from '@/lib/queries/products';
import { withUserContext } from '@growmy/db/context';

/**
 * AVVIO DEL COLLEGAMENTO A SEARCH CONSOLE.
 *
 * Perché una route e non una Server Action: il flusso termina con un redirect
 * verso un dominio esterno (`accounts.google.com`). Le Server Actions possono
 * redirigere solo entro l'applicazione, e restituire l'URL al client per farlo
 * navigare a mano sposterebbe la costruzione dei parametri OAuth nel browser —
 * dove `state` non sarebbe più firmato lato server.
 *
 * `GET` è corretto qui nonostante non sia una lettura pura: la navigazione
 * verso il consenso OAuth È una navigazione, e il passo che modifica davvero
 * qualcosa (scrivere la connessione) avviene al ritorno, dietro un token
 * monouso. Il CSRF è coperto dallo `state` firmato, non dal metodo.
 *
 * Origine del redirect da `NEXT_PUBLIC_APP_URL` e non da `request.url`, per lo
 * stesso motivo documentato in `app/auth/callback/route.ts`: dietro il reverse
 * proxy `request.url` riflette l'indirizzo di ascolto del container.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const productId = searchParams.get('productId');
  const orgSlug = searchParams.get('orgSlug');
  const origin = env.NEXT_PUBLIC_APP_URL;

  if (!productId || !orgSlug) {
    return NextResponse.redirect(`${origin}/`);
  }

  try {
    /**
     * Collegare una sorgente dati esterna è al livello delle integrazioni CMS,
     * non della gestione ordinaria dei contenuti: admin, non editor. Stesso
     * criterio di `integrations.impl.ts`.
     */
    const membership = await assertOrgRole(orgSlug, 'admin');

    // Il prodotto deve appartenere davvero a quell'organizzazione: senza questo
    // controllo un admin potrebbe avviare il flusso indicando lo slug della
    // propria org e l'id di un prodotto altrui.
    const product = await withUserContext(membership.userId, () =>
      getProductById(membership.organizationId, productId),
    );

    if (!product) {
      return NextResponse.redirect(`${origin}/${orgSlug}/products`);
    }

    const consentUrl = buildGscConsentUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: gscRedirectUri(),
      state: signGscState({
        productId,
        orgSlug,
        userId: membership.userId,
      }),
    });

    return NextResponse.redirect(consentUrl);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      // 404 e non 403: non confermiamo a un estraneo che quello slug esiste.
      return NextResponse.redirect(`${origin}/`);
    }

    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'avvio del collegamento Search Console fallito',
    );

    return NextResponse.redirect(
      `${origin}/${orgSlug}/products/${productId}/analytics?gsc_error=start_failed`,
    );
  }
}
