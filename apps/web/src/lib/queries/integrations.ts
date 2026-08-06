import 'server-only';

import { db, integrations } from '@growmy/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * QUERY DELLE INTEGRAZIONI.
 *
 * MAI le colonne cifrate (`encryptedCredentials`/`credentialsIv`): stesso
 * principio già applicato a livello di RLS in `0001_rls_policies.sql`
 * (`REVOKE ALL` + `GRANT SELECT` colonna-per-colonna su questa tabella) —
 * qui lo ribadiamo a livello di query, difesa in profondità.
 */
export async function getIntegrationForProduct(productId: string) {
  const [row] = await db
    .select({
      id: integrations.id,
      provider: integrations.provider,
      status: integrations.status,
      label: integrations.label,
      lastHealthCheckAt: integrations.lastHealthCheckAt,
      lastErrorMessage: integrations.lastErrorMessage,
      consecutiveFailures: integrations.consecutiveFailures,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.productId, productId),
        eq(integrations.isPrimary, true),
        isNull(integrations.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}
