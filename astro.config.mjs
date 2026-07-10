// @ts-check
import { defineConfig } from 'astro/config';
import icons from 'unplugin-icons/vite';
import tailwindcss from '@tailwindcss/vite';
import { dataSymlinks, githubPages, siteConfig } from './.castro/config.ts';

export default defineConfig({
	...githubPages(),
	...siteConfig({
		title: 'Forum Archive',
	}),
	vite: {
		plugins: [
			icons({
				compiler: 'astro',
			}),
			tailwindcss(),
			dataSymlinks(),
		],
	},
});
