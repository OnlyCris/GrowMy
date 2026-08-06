import { withUserContext } from '@growmy/db/context';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { IntegrationHealthBadge } from '@/components/shared/status-badge';
import { requireOrgMembership } from '@/lib/auth/guards';
import { getIntegrationForProduct } from '@/lib/queries/integrations';
import { formatRelativeTime } from '@/lib/utils';

import { ConnectWebhookForm } from './_components/connect-webhook-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Integrazione',
  robots: { index: false, follow: false },
};

export default async function ProductIntegrationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; productId: string }>;
}) {
  const { orgSlug, productId } = await params;

  const membership = await requireOrgMembership(orgSlug);
  if (!membership) notFound();

  const integration = await withUserContext(membership.userId, () =>
    getIntegrationForProduct(productId),
  );

  if (!integration) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground-muted">
          Nessuna integrazione collegata. Gli articoli approvati non verranno
          pubblicati finché non ne colleghi una.
        </p>
        <ConnectWebhookForm productId={productId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">
          {integration.label ?? 'Webhook'}
        </p>
        <IntegrationHealthBadge status={integration.status} />
      </div>
      {integration.lastHealthCheckAt ? (
        <p className="text-xs text-foreground-muted">
          Ultimo controllo {formatRelativeTime(integration.lastHealthCheckAt)}
        </p>
      ) : (
        <p className="text-xs text-foreground-muted">
          Verifica di connettività in corso — aggiorna fra qualche secondo.
        </p>
      )}
      {integration.lastErrorMessage ? (
        <p className="rounded-[var(--radius-md)] bg-danger-100 px-3 py-2 text-sm text-danger-700">
          {integration.lastErrorMessage}
        </p>
      ) : null}
    </div>
  );
}
