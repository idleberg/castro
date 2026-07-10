// @ts-check
import { defineConfig, envField } from 'astro/config';
import icons from 'unplugin-icons/vite';
import tailwindcss from '@tailwindcss/vite';

const isPagesAction = Boolean(process.env.GITHUB_ACTIONS);
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
const isUserRepo = repo === `${owner}.github.io`;

export default defineConfig({
	...(isPagesAction && {
		site: `https://${owner}.github.io`,
		...(!isUserRepo && { base: `/${repo}` }),
	}),
	env: {
		schema: {
			SITE_NAME: envField.string({
				context: 'server',
				access: 'public',
				default: 'Forum Archive',
			}),
			META_DESCRIPTION: envField.string({
				context: 'server',
				access: 'public',
				optional: true,
			}),
			META_KEYWORDS: envField.string({
				context: 'server',
				access: 'public',
				optional: true,
			}),
		},
	},
	vite: {
		plugins: [
			icons({
				compiler: 'astro',
			}),
			tailwindcss(),
		],
	},
});
