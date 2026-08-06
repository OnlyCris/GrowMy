'use client';

import * as React from 'react';

import { connectWebhookIntegrationAction } from '@/actions/integrations.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ConnectWebhookForm({ productId }: { productId: string }) {
  const [targetUrl, setTargetUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});
  const [signingSecret, setSigningSecret] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await connectWebhookIntegrationAction({
        productId,
        targetUrl,
        label: label || undefined,
      });
      if (result.ok) {
        setSigningSecret(result.data.signingSecret);
      } else {
        setError(result.message);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  async function handleCopy() {
    if (!signingSecret) return;
    await navigator.clipboard.writeText(signingSecret);
    setCopied(true);
  }

  if (signingSecret) {
    return (
      <div className="flex flex-col gap-3 rounded-[var(--radius-md)] bg-info-100 p-4">
        <p className="text-sm font-medium text-info-700">
          Integrazione avviata. Copia questo segreto ora: non verrà mostrato di
          nuovo.
        </p>
        <p className="text-xs text-foreground-muted">
          Incollalo nella configurazione del webhook su menuisland.it — serve a
          verificare che ogni richiesta arrivi davvero da GrowMy (firma HMAC
          nell&rsquo;header <code>X-GrowMy-Signature</code>).
        </p>
        <code className="break-all rounded-[var(--radius-sm)] bg-surface px-3 py-2 text-xs">
          {signingSecret}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
          {copied ? 'Copiato' : 'Copia segreto'}
        </Button>
        <p className="text-xs text-foreground-muted">
          Verifica della connessione in corso — aggiorna la pagina fra qualche
          secondo per vedere lo stato.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="integration-url">URL del webhook</Label>
        <Input
          id="integration-url"
          type="url"
          required
          placeholder="https://menuisland.it/api/growmy-webhook"
          value={targetUrl}
          onChange={(event) => setTargetUrl(event.target.value)}
          aria-invalid={fieldErrors.targetUrl ? true : undefined}
        />
        <FormError messages={fieldErrors.targetUrl} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="integration-label">Etichetta (opzionale)</Label>
        <Input
          id="integration-label"
          placeholder="es. Blog menuisland.it"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>

      <FormError messages={error} />

      <Button type="submit" isLoading={isPending} loadingLabel="Connessione in corso">
        Collega
      </Button>
    </form>
  );
}
