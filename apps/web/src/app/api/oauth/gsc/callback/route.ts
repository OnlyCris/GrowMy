import { env } from '@growmy/env';
import {
  exchangeGscCode,
  fetchGscAccountEmail,
  GscError,
  listGscSites,
} from '@growmy/integrations';
import { NextResponse } from 'next/server';

import {
  gscRedirectUri,
  storePendingGscConnection,
  verifyGscState,
} from '@/lib/gsc-oauth';
import { logger } from '@/lib/logger';
import { getAuthenticatedUser } from '@/lib/supabase/server';

/**
 * RITORNO DAL CONSENSO GOOGLE.
 *
 * Qui NON si scrive niente sul database. Il processo web non possiede
 * `CREDENTIALS_ENCRYPTION_KEY` — vive solo nel worker — quindi non può cifrare
 * un refresh token, e scriverlo in chiaro vanificherebbe esattamente la
 * separazione che quella scelta protegge.
 *
 * Il callback fa tre cose e si ferma: scambia il codice, chiede a Google quali
 * property sono leggibili, deposita il tutto in una custodia temporanea su
 * Redis (vedi `lib/gsc-oauth.ts`). La scrittura vera avviene dopo che l'utente
 * ha scelto la property, in un job che il worker esegue con la chiave giusta.
 *
 * `noindex` implicito: la route non rende mai HTML, solo redirect.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const origin = env.NEXT_PUBLIC_APP_URL;

  const state = verifyGscState(searchParams.get('state'));
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error');

  /**
   * State non valido: firma sbagliata, scaduto o assente. Non sappiamo su quale
   * prodotto stavamo lavorando, quindi non c'è una pagina sensata dove tornare.
   * Non logghiamo il valore ricevuto: sarebbe input non fidato in un log.
   */
  if (!state) {
    logger.warn('callback Search Console con state non valido o scaduto');
    return NextResponse.redirect(`${origin}/?gsc_error=invalid_state`);
  }

  const analyticsUrl = `${origin}/${state.orgSlug}/products/${state.productId}/analytics`;

  /**
   * La sessione va riverificata: lo state è firmato e prova che il flusso è
   * partito da noi, ma non prova che a tornare sia lo stesso browser. Senza
   * questo controllo un link con uno state ancora valido, aperto da un altro
   * utente, depositerebbe la connessione a suo nome.
   */
  const user = await getAuthenticatedUser();
  if (!user || user.id !== state.userId) {
    return NextResponse.redirect(`${origin}/signin`);
  }

  // L'utente ha premuto "Annulla" sulla schermata di consenso: non è un errore,
  // è una decisione. Torna alla pagina senza allarmi.
  if (oauthError === 'access_denied') {
    return NextResponse.redirect(`${analyticsUrl}?gsc_error=access_denied`);
  }

  if (oauthError || !code) {
    logger.warn({ oauthError }, 'consenso Search Console non concluso');
    return NextResponse.redirect(`${analyticsUrl}?gsc_error=consent_failed`);
  }

  try {
    const tokens = await exchangeGscCode({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri: gscRedirectUri(),
    });

    /**
     * Senza refresh token la connessione sarebbe viva un'ora e poi morta senza
     * un motivo visibile. Succede quando Google considera il consenso già dato
     * e salta il rilascio; `prompt=consent` in `buildGscConsentUrl` serve
     * proprio a impedirlo, ma se accade lo diciamo subito invece di scoprirlo
     * il giorno dopo con un sync fallito.
     */
    if (!tokens.refreshToken) {
      logger.warn(
        { productId: state.productId },
        'Google non ha rilasciato un refresh token',
      );
      return NextResponse.redirect(`${analyticsUrl}?gsc_error=no_refresh_token`);
    }

    const [sites, connectedEmail] = await Promise.all([
      listGscSites(tokens.accessToken),
      fetchGscAccountEmail(tokens.accessToken),
    ]);

    /**
     * Nessuna property leggibile: l'account Google è valido ma non ha accesso a
     * nessun sito verificato. È l'errore di setup più comune (si autorizza
     * l'account sbagliato) e merita un messaggio proprio, non un elenco vuoto.
     */
    if (sites.length === 0) {
      return NextResponse.redirect(`${analyticsUrl}?gsc_error=no_sites`);
    }

    const token = await storePendingGscConnection({
      productId: state.productId,
      userId: state.userId,
      refreshToken: tokens.refreshToken,
      connectedEmail,
      sites,
    });

    logger.info(
      { productId: state.productId, siteCount: sites.length },
      'consenso Search Console ottenuto: in attesa della scelta della property',
    );

    return NextResponse.redirect(
      `${analyticsUrl}?gsc_connect=${encodeURIComponent(token)}`,
    );
  } catch (error) {
    if (error instanceof GscError) {
      logger.warn(
        { code: error.code, productId: state.productId },
        'collegamento Search Console rifiutato da Google',
      );
      return NextResponse.redirect(
        `${analyticsUrl}?gsc_error=${encodeURIComponent(error.code)}`,
      );
    }

    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'collegamento Search Console fallito',
    );
    return NextResponse.redirect(`${analyticsUrl}?gsc_error=unexpected`);
  }
}
