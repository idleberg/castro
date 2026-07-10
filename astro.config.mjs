// @ts-check
import { defineConfig } from 'astro/config';
import icons from 'unplugin-icons/vite';
import tailwindcss from '@tailwindcss/vite';
import { githubPages, siteConfig } from './.castro/config.ts';

export default defineConfig({
	...githubPages(),
	...siteConfig(),
	vite: {
		plugins: [
			icons({
				compiler: 'astro',
			}),
			tailwindcss(),
		],
	},
});
