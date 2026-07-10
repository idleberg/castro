import { envField } from 'astro/config';

export function githubPages(): { site?: string; base?: string } {
	if (!process.env.GITHUB_ACTIONS) return {};

	const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
	const isUserRepo = repo === `${owner}.github.io`;

	return {
		site: `https://${owner}.github.io`,
		...(!isUserRepo && { base: `/${repo}` }),
	};
}

interface SiteConfigOptions {
	title?: string;
	description?: string;
	keywords?: string[];
}

export function siteConfig({ title, description, keywords }: SiteConfigOptions = {}) {
	return {
		env: {
			schema: {
				SITE_NAME: envField.string({
					context: 'server',
					access: 'public',
					default: title ?? '⌘',
				}),
				META_DESCRIPTION: envField.string({
					context: 'server',
					access: 'public',
					...(description ? { default: description } : { optional: true }),
				}),
				META_KEYWORDS: envField.string({
					context: 'server',
					access: 'public',
					...(keywords?.length ? { default: keywords.join(', ') } : { optional: true }),
				}),
			},
		},
	};
}
