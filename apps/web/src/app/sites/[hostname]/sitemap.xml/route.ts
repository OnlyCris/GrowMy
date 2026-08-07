import { getProductByBlogDomain, getPublishedArticlesForBlog } from '@/lib/queries/blog';

export const dynamic = 'force-dynamic';

function escapeXml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ hostname: string }> }) {
  const { hostname } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) return new Response('Not found', { status: 404 });

  const articles = await getPublishedArticlesForBlog(product.id);

  const urls = [
    `<url><loc>https://${hostname}/</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...articles.map((article) => {
      const loc = `https://${hostname}/${escapeXml(article.slug ?? '')}`;
      const lastmod = article.publishedAt ? new Date(article.publishedAt).toISOString() : undefined;
      return `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>monthly</changefreq><priority>0.6</priority></url>`;
    }),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
