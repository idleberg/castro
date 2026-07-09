import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForumData, ThreadData, MemberData } from './types.ts';
export type { MemberData } from './types.ts';
import { threadSlug } from './format.ts';

const DATA_ROOT = join(process.cwd(), 'data');

// Use globalThis so caches survive module re-evaluation during Astro's build
const g = globalThis as Record<string, unknown>;

function cached<T>(key: string, loader: () => Promise<T>): () => Promise<T> {
	const cacheKey = `__castro_${key}`;
	return async () => {
		if (g[cacheKey]) return g[cacheKey] as T;
		const value = await loader();
		g[cacheKey] = value;
		return value;
	};
}

// --- Low-level loaders ---

async function readJsonDir<T>(subdir: string): Promise<T[]> {
	const dir = join(DATA_ROOT, subdir);
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
	} catch {
		return [];
	}
	return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))));
}

const loadForums = cached('forums', () => readJsonDir<ForumData>('forums'));

const loadAllMembers = cached('members', async () => {
	const list = await readJsonDir<MemberData>('members');
	return new Map(list.map((m) => [m.id, m]));
});

const loadAllThreads = cached('threads', async () => {
	const cache = new Map<string, ThreadData>();
	const threadsDir = join(DATA_ROOT, 'threads');
	let subs: string[];
	try {
		subs = await readdir(threadsDir);
	} catch {
		return cache;
	}
	await Promise.all(
		subs.map(async (sub) => {
			let files: string[];
			try {
				files = (await readdir(join(threadsDir, sub))).filter((f) => f.endsWith('.json'));
			} catch {
				return;
			}
			await Promise.all(
				files.map(async (f) => {
					const id = f.replace('.json', '');
					if (cache.has(id)) return;
					try {
						cache.set(id, JSON.parse(await readFile(join(threadsDir, sub, f), 'utf-8')));
					} catch {}
				}),
			);
		}),
	);
	return cache;
});

const loadThreadToForum = cached('threadToForum', async () => {
	const map = new Map<string, { name: string; channelId: number }>();
	const forums = await loadForums();
	const threadsDir = join(DATA_ROOT, 'threads');
	for (const forum of forums) {
		const subDir = join(threadsDir, String(forum.channelId));
		let files: string[];
		try {
			files = await readdir(subDir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (f.endsWith('.json')) {
				const id = f.replace('.json', '');
				if (!map.has(id)) {
					map.set(id, { name: forum.name, channelId: forum.channelId });
				}
			}
		}
	}
	return map;
});

const loadMemberThreadIndex = cached('memberThreadIndex', async () => {
	const index = new Map<string, { id: string; title: string; slug: string; lastDate: string }[]>();
	const threads = await loadAllThreads();
	for (const [id, thread] of threads) {
		const byAuthor = new Map<string, string>();
		for (const post of thread.posts) {
			const existing = byAuthor.get(post.author);
			if (!existing || post.created > existing) {
				byAuthor.set(post.author, post.created);
			}
		}
		const slug = threadSlug(id, thread.title);
		for (const [author, lastDate] of byAuthor) {
			let list = index.get(author);
			if (!list) {
				list = [];
				index.set(author, list);
			}
			list.push({ id, title: thread.title, slug, lastDate });
		}
	}
	for (const list of index.values()) {
		list.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
		if (list.length > 10) list.length = 10;
	}
	return index;
});

// --- Public API ---

export function getForums(): Promise<ForumData[]> {
	return loadForums();
}

export async function getForum(channelId: number): Promise<ForumData | undefined> {
	const forums = await loadForums();
	return forums.find((f) => f.channelId === channelId);
}

export async function getThread(id: string): Promise<ThreadData | undefined> {
	const threads = await loadAllThreads();
	return threads.get(id);
}

export async function getAllThreadIds(): Promise<string[]> {
	const threads = await loadAllThreads();
	return [...threads.keys()];
}

export async function getAllMembers(): Promise<MemberData[]> {
	const members = await loadAllMembers();
	return [...members.values()];
}

export async function getMember(id: number): Promise<MemberData | undefined> {
	const members = await loadAllMembers();
	return members.get(id);
}

export interface ThreadTeaser {
	title: string;
	author: string;
	excerpt: string;
	postCount: number;
}

function stripHtml(html: string): string {
	return html
		.replaceAll(/<[^>]*>/gu, ' ')
		.replaceAll('&nbsp;', ' ')
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll(/\s+/gu, ' ')
		.trim();
}

export async function getThreadTeaser(id: string): Promise<ThreadTeaser | undefined> {
	const thread = await getThread(id);
	if (!thread || thread.posts.length === 0) return undefined;
	const first = thread.posts[0];
	const plain = stripHtml(first.body);
	return {
		title: thread.title,
		author: first.author,
		excerpt: plain.length > 200 ? plain.slice(0, 200) + '…' : plain,
		postCount: thread.posts.length,
	};
}

export async function getThreadsForMember(memberName: string): Promise<{ id: string; title: string; slug: string }[]> {
	const index = await loadMemberThreadIndex();
	return index.get(memberName) ?? [];
}

export interface Breadcrumb {
	label: string;
	href: string;
}

export async function getForumForThread(threadId: string): Promise<{ name: string; channelId: number } | undefined> {
	const map = await loadThreadToForum();
	return map.get(threadId);
}
