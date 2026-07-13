import { envField } from 'astro/config';
import { existsSync, symlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import icons from 'unplugin-icons/vite';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import type { AstroIntegration, AstroUserConfig, ViteUserConfig } from 'astro';

interface CastroConfig {
	title: string;
	description?: string;
	keywords?: string[];
	githubPages?: boolean;
	integration: AstroIntegration[];
	vite?: ViteUserConfig;
}

export function defineConfig({
	title,
	description,
	keywords,
	githubPages,
	integration,
	vite,
}: CastroConfig): AstroUserConfig {
	return {
		...(githubPages ? resolveGithubPages() : {}),
		env: {
			schema: {
				SITE_NAME: envField.string({
					context: 'server',
					access: 'public',
					default: title,
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
		integrations: [...(integration ?? []), sitemap()],
		vite: {
			...vite,
			plugins: [icons({ compiler: 'astro' }), tailwindcss(), ...(vite?.plugins ?? []), dataSymlinks()],
		},
	};
}

function resolveGithubPages(): { site?: string; base?: string } {
	if (!process.env.GITHUB_ACTIONS) return {};

	const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
	const isUserRepo = repo === `${owner}.github.io`;

	return {
		site: `https://${owner}.github.io`,
		...(!isUserRepo && { base: `/${repo}` }),
	};
}

function dataSymlinks(): { name: string; configResolved: (config: { root: string }) => void } {
	return {
		name: 'castro:data-symlinks',
		configResolved(config) {
			const publicDir = resolve(config.root, 'public');
			const link = resolve(publicDir, 'attachments');
			if (!existsSync(link)) {
				const target = relative(publicDir, resolve(config.root, 'data', 'attachments'));
				symlinkSync(target, link);
			}
		},
	};
}
