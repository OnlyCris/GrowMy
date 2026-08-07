'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { deleteArticleAction } from '@/actions/articles.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';

export function DeleteArticleButton({
  articleId,
  redirectTo,
}: {
  articleId: string;
  redirectTo: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteArticleAction({ articleId });
      if (result.ok) {
        router.push(redirectTo);
      } else {
        setError(result.message);
        setConfirming(false);
      }
    });
  }

  if (!confirming) {
    return (
      <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Elimina
      </Button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-foreground-muted">Eliminare definitivamente?</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Annulla
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          isLoading={isPending}
          loadingLabel="Eliminazione"
          onClick={handleDelete}
        >
          Conferma eliminazione
        </Button>
      </div>
      <FormError messages={error} />
    </div>
  );
}
