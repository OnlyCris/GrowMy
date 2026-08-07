import { getProductByBlogDomain } from '@/lib/queries/blog';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ hostname: string }> }) {
  const { hostname } = await params;
  const product = await getProductByBlogDomain(hostname);
  if (!product) return new Response('Not found', { status: 404 });

  const body = `User-agent: *\nAllow: /\n\nSitemap: https://${hostname}/sitemap.xml\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
