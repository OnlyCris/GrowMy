'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { retryArticleAction } from '@/actions/articles.actions';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form-error';

export function RetryArticleButton({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleRetry() {
    setError(null);
    startTransition(async () => {
      const result = await retryArticleAction({ articleId });
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        isLoading={isPending}
        loadingLabel="Nuovo tentativo in corso"
        onClick={handleRetry}
      >
        Riprova
      </Button>
      <FormError messages={error} />
    </div>
  );
}
