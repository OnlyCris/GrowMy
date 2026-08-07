'use client';

import Link from 'next/link';
import * as React from 'react';

import { Input } from '@/components/ui/input';

interface BlogArticleListItem {
  id: string;
  title: string | null;
  slug: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  wordCount: number | null;
}

const dateFormatter = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Filtro lato client sul titolo: con poche decine di articoli non serve
 * un indice di ricerca separato, e la lista è già interamente in pagina —
 * filtrarla è gratis e istantaneo, l'esperienza che conta per la
 * navigazione più che una ricerca "seria" con relevance scoring.
 */
export function BlogArticleList({ articles }: { articles: BlogArticleListItem[] }) {
  const [query, setQuery] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return articles;
    return articles.filter(
      (a) =>
        a.title?.toLowerCase().includes(q) || a.excerpt?.toLowerCase().includes(q),
    );
  }, [articles, query]);

  return (
    <div className="mt-8">
      {articles.length > 5 ? (
        <Input
          type="search"
          placeholder="Cerca fra gli articoli…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Cerca articoli"
          className="max-w-sm"
        />
      ) : null}

      {filtered.length === 0 ? (
        <p className="mt-8 text-sm text-foreground-muted">Nessun articolo trovato.</p>
      ) : (
        <ul className="mt-6 flex flex-col divide-y divide-border">
          {filtered.map((article) => {
            const readingMinutes = article.wordCount
              ? Math.max(1, Math.round(article.wordCount / 200))
              : null;
            return (
              <li key={article.id} className="py-6 first:pt-0">
                <Link
                  href={`/${article.slug}`}
                  className="text-lg font-semibold text-foreground hover:underline"
                >
                  {article.title}
                </Link>
                {article.excerpt ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                    {article.excerpt}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-foreground-subtle">
                  {article.publishedAt ? dateFormatter.format(article.publishedAt) : ''}
                  {article.publishedAt && readingMinutes ? ' · ' : ''}
                  {readingMinutes ? `${readingMinutes} min di lettura` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
