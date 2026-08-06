'use server';

import type { SignInInput, SignUpInput } from '@growmy/validation';

import * as auth from './auth.impl';

/**
 * CONFINE SERVER DELL'AUTENTICAZIONE
 *
 * Stesso pattern di `review.actions.ts`: file sottile, solo firme esplicite
 * verso il client, zero logica. Un modulo `'use server'` fa sì che Next generi
 * un endpoint invocabile per ogni funzione esportata — comprese eventuali
 * arrow inline dentro un oggetto di configurazione, che il compilatore non sa
 * distinguere da un'azione voluta. Tenere `sendMagicLink` e i
 * `createBootstrapAction(...)` in `auth.impl.ts` (`server-only`, non
 * raggiungibile dal client) evita che diventino endpoint pubblici per errore.
 */

export async function signInAction(input: SignInInput) {
  return auth.signIn(input);
}

export async function signUpAction(input: SignUpInput) {
  return auth.signUp(input);
}

export async function signOutAction() {
  return auth.signOut();
}
