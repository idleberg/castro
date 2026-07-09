import { defineConfig } from 'oxlint';

export default defineConfig({
	plugins: ['import', 'typescript', 'unicorn'],
	env: {
		browser: true,
		es2024: true,
	},
	categories: {
		correctness: 'error',
		suspicious: 'warn',
		pedantic: 'warn',
	},
	rules: {
		eqeqeq: 'warn',
		'import/no-cycle': 'error',
		'no-underscore-dangle': ['warn', { allow: ['__popup'] }],
		'import/no-unassigned-import': ['warn', { allow: ['**/*.css'] }],
		'import/no-named-as-default-member': 'off',
	},
	ignorePatterns: ['dist/', '.astro/', 'node_modules/'],
});
