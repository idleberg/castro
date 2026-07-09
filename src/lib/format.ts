import DOMPurify from 'isomorphic-dompurify';

export function routePath(path: string): string {
	const base = import.meta.env.BASE_URL.replace(/\/$/u, '');
	return `${base}${path}`;
}

export function sanitizeHtml(html: string): string {
	return DOMPurify.sanitize(html);
}

export function formatDate(iso: string): string {
	if (!iso) return '';
	return new Date(iso).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}

export function formatDateTime(iso: string): string {
	if (!iso) return '';
	return new Intl.DateTimeFormat('en-US', {
		dateStyle: 'long',
		timeStyle: 'short',
	}).format(new Date(iso));
}

export function threadIdFromUrl(url: string): string {
	return url.match(/\/(\d+)-/u)?.[1] ?? '';
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replaceAll(/[̀-ͯ]/gu, '')
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-|-$/gu, '');
}

export function threadSlug(id: string | number, title: string): string {
	return `${id}/${slugify(title)}`;
}

export function memberSlug(id: string | number, name: string): string {
	return `${id}/${slugify(name)}`;
}
