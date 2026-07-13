import { envField } from 'astro/config';
import { existsSync, symlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import icons from 'unplugin-icons/vite';
import tailwindcss from '@tailwindcss/vite';
import type { AstroIntegration } from 'astro';

interface CastroConfig {
	title: string;
	description?: string;
	keywords?: string[];
	githubPages?: boolean;
}

export default function castro(options: CastroConfig): AstroIntegration {
	return {
		name: 'castro',
		hooks: {
			'astro:config:setup'({ config, updateConfig }) {
				updateConfig({
					...resolveSite(config, options.githubPages),
					env: { schema: resolveEnvSchema(options) },
					vite: {
						plugins: [icons({ compiler: 'astro' }), tailwindcss(), dataSymlinks()],
					},
				});
			},
		},
	};
}

function resolveSite(
	config: { site?: string; server: { port: number } },
	githubPages?: boolean,
): { site?: string; base?: string } {
	if (config.site) return {};

	if (githubPages && process.env.GITHUB_ACTIONS) {
		const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
		const isUserRepo = repo === `${owner}.github.io`;
		return {
			site: `https://${owner}.github.io`,
			...(!isUserRepo && { base: `/${repo}` }),
		};
	}

	return { site: `http://localhost:${config.server.port}` };
}

function resolveEnvSchema({ title, description, keywords }: CastroConfig) {
	return {
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
