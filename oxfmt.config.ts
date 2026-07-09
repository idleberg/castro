import { defineConfig } from 'oxfmt';

export default defineConfig({
	useTabs: true,
	tabWidth: 2,
	singleQuote: true,
	trailingComma: 'all',
	semi: true,
	printWidth: 120,
	arrowParens: 'always',
	bracketSpacing: true,
	endOfLine: 'lf',
	ignorePatterns: ['dist/', '.astro/', 'node_modules/'],
});
