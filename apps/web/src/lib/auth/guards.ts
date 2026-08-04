import { db, organizationMembers, organizations } from '@growmy/db';
import { and, eq, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { cache } from 'react';

import { getAuthenticatedUser } from '@/lib/supabase/server';

/**
 * GUARDS DI AUTORIZZAZIONE
 *
 * Un solo punto in tutta l'applicazione risolve "chi sei e cosa puoi fare in
 * questa organizzazione". Ogni Server Component, Server Action e route handler
 * passa da qui.
 *
 * Principio: il ruolo si legge SEMPRE dal database, mai da un claim del JWT.
 * I claim sono comodi ma diventano stantii nell'istante in cui un admin
 * declassa un membro: quel membro conserverebbe i privilegi fino alla scadenza
 * del token. Una query indicizzata su (user_id, organization_id) costa meno di
 * una finestra di privilegi non revocabili.
 */

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface OrgMembership {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: OrgRole;
}

/** Gerarchia dei ruoli. Un numero più alto include tutti i permessi dei minori. */
const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function hasAtLeastRole(actual: OrgRole, required: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/**
 * Risolve la membership dell'utente autenticato per lo slug indicato.
 * Ritorna `null` se non autenticato, se l'organizzazione non esiste o se
 * l'utente non ne fa parte — i tre casi sono deliberatamente indistinguibili
 * dal chiamante.
 *
 * `cache()` deduplica per richiesta: layout e pagina chiedono la stessa
 * membership e la query viene eseguita una volta sola.
 */
export const getOrgMembership = cache(
  async (orgSlug: string): Promise<OrgMembership | null> => {
    const user = await getAuthenticatedUser();
    if (!user) return null;

    const [row] = await db
      .select({
        organizationId: organizations.id,
        organizationSlug: organizations.slug,
        organizationName: organizations.name,
        role: organizationMembers.role,
      })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMembers.organizationId),
      )
      .where(
        and(
          eq(organizationMembers.userId, user.id),
          eq(organizations.slug, orgSlug),
          isNull(organizations.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      userId: user.id,
      organizationId: row.organizationId,
      organizationSlug: row.organizationSlug,
      organizationName: row.organizationName,
      role: row.role,
    };
  },
);

/**
 * Variante per le pagine. Ritorna `null` invece di lanciare, così il chiamante
 * può decidere fra `notFound()` e un redirect.
 *
 * NOTA DI SICUREZZA: il chiamante deve rispondere 404 e non 403 quando la
 * membership manca. Un 403 confermerebbe a un estraneo che quello slug esiste,
 * il che è una fuga di informazione (enumerazione dei tenant).
 */
export async function requireOrgMembership(
  orgSlug: string,
): Promise<OrgMembership | null> {
  return getOrgMembership(orgSlug);
}

/**
 * Variante per i layout dell'area autenticata: se non c'è sessione manda al
 * login conservando la destinazione, così dopo l'accesso l'utente atterra dove
 * voleva andare.
 *
 * `redirectTo` è un percorso relativo validato: accettare un URL assoluto
 * aprirebbe una open redirect verso un dominio di phishing.
 */
export async function requireSession(currentPath?: string): Promise<{
  userId: string;
  email: string | null;
}> {
  const user = await getAuthenticatedUser();

  if (!user) {
    const isSafeRelativePath =
      typeof currentPath === 'string' &&
      currentPath.startsWith('/') &&
      !currentPath.startsWith('//');

    redirect(
      isSafeRelativePath
        ? `/signin?redirectTo=${encodeURIComponent(currentPath)}`
        : '/signin',
    );
  }

  return { userId: user.id, email: user.email };
}

/**
 * Errore tipizzato per le Server Actions.
 * Il wrapper `safe-action` lo converte in un `ActionResult` con codice
 * macchina: nessuna eccezione grezza raggiunge mai il client.
 */
export class AuthorizationError extends Error {
  constructor(
    public readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * Guard per le Server Actions: richiede una membership con ruolo minimo.
 * Lancia `AuthorizationError`, che il wrapper intercetta.
 */
export async function assertOrgRole(
  orgSlug: string,
  minimumRole: OrgRole,
): Promise<OrgMembership> {
  const membership = await getOrgMembership(orgSlug);

  if (!membership) {
    throw new AuthorizationError(
      'NOT_FOUND',
      'Organizzazione non trovata o accesso non consentito.',
    );
  }

  if (!hasAtLeastRole(membership.role, minimumRole)) {
    throw new AuthorizationError(
      'FORBIDDEN',
      `Questa azione richiede il ruolo ${minimumRole} o superiore.`,
    );
  }

  return membership;
}

/**
 * Variante che parte dall'id dell'organizzazione invece che dallo slug.
 * Usata dalle azioni che ricevono un `articleId` e risalgono al tenant:
 * il controllo verifica che l'utente appartenga proprio a QUELL'organizzazione,
 * non a una qualsiasi.
 */
export async function assertOrgRoleById(
  organizationId: string,
  minimumRole: OrgRole,
): Promise<OrgMembership> {
  const user = await getAuthenticatedUser();
  if (!user) {
    throw new AuthorizationError('UNAUTHENTICATED', 'Sessione non valida.');
  }

  const [row] = await db
    .select({
      role: organizationMembers.role,
      organizationSlug: organizations.slug,
      organizationName: organizations.name,
    })
    .from(organizationMembers)
    .innerJoin(
      organizations,
      eq(organizations.id, organizationMembers.organizationId),
    )
    .where(
      and(
        eq(organizationMembers.userId, user.id),
        eq(organizationMembers.organizationId, organizationId),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);

  if (!row) {
    throw new AuthorizationError('NOT_FOUND', 'Risorsa non trovata.');
  }

  if (!hasAtLeastRole(row.role, minimumRole)) {
    throw new AuthorizationError(
      'FORBIDDEN',
      `Questa azione richiede il ruolo ${minimumRole} o superiore.`,
    );
  }

  return {
    userId: user.id,
    organizationId,
    organizationSlug: row.organizationSlug,
    organizationName: row.organizationName,
    role: row.role,
  };
}
