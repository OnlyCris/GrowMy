import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { signInAction } from '@/actions/auth.actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { AuthDivider } from '../_components/auth-divider';
import { GoogleOAuthButton } from '../_components/google-oauth-button';
import { MagicLinkForm } from '../_components/magic-link-form';

export const metadata: Metadata = {
  title: 'Accedi',
  // Dietro autenticazione (o quasi): nessun motore di ricerca deve indicizzarla.
  robots: { index: false, follow: false },
};

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accedi</CardTitle>
        <CardDescription>
          Ti mandiamo un link di accesso via email — niente password da ricordare.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <Suspense>
          <GoogleOAuthButton />
        </Suspense>

        <AuthDivider />

        <Suspense>
          <MagicLinkForm action={signInAction} submitLabel="Invia link di accesso" />
        </Suspense>

        <p className="text-center text-sm text-foreground-muted">
          Non hai un account?{' '}
          <Link
            href="/signup"
            className="text-info-700 underline underline-offset-4 hover:no-underline"
          >
            Registrati
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
