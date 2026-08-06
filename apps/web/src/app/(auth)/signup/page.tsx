import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { signUpAction } from '@/actions/auth.actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AuthDivider } from '../_components/auth-divider';
import { GoogleOAuthButton } from '../_components/google-oauth-button';
import { MagicLinkForm } from '../_components/magic-link-form';

export const metadata: Metadata = {
  title: 'Crea account',
  robots: { index: false, follow: false },
};

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Crea il tuo account</CardTitle>
        <CardDescription>
          Nessuna password da scegliere: ti mandiamo un link di accesso via email.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Suspense>
          <GoogleOAuthButton />
        </Suspense>

        <AuthDivider />

        <Suspense>
          <MagicLinkForm action={signUpAction} submitLabel="Crea account" />
        </Suspense>

        <p className="text-center text-sm text-foreground-muted">
          Hai già un account?{' '}
          <Link
            href="/signin"
            className="text-info-700 underline underline-offset-4 hover:no-underline"
          >
            Accedi
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
