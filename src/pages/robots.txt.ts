import type { APIRoute } from 'astro';

const getRobotsTxt = (sitemapURL?: URL) => `\
User-agent: *
Allow: /
${sitemapURL ? `\nSitemap: ${sitemapURL.href}` : ''}
`;

export const GET: APIRoute = ({ site }) => {
	if (!site) {
		return new Response(getRobotsTxt());
	}

	const sitemapURL = new URL('sitemap-index.xml', site);

	return new Response(getRobotsTxt(sitemapURL));
};
