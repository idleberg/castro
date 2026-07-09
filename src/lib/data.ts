import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForumData, ThreadData, MemberData } from './types.ts';
import { threadSlug } from './format.ts';

const DATA_ROOT = join(process.cwd(), 'data');

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

export function getForums(): Promise<ForumData[]> {
	return readJsonDir<ForumData>('forums');
}

export async function getForum(channelId: number): Promise<ForumData | undefined> {
	const forums = await getForums();
	return forums.find((f) => f.channelId === channelId);
}

export async function getThread(id: string): Promise<ThreadData | undefined> {
	const threadsDir = join(DATA_ROOT, 'threads');
	let subs: string[];
	try {
		subs = await readdir(threadsDir);
	} catch {
		return undefined;
	}
	for (const sub of subs) {
		const path = join(threadsDir, sub, `${id}.json`);
		try {
			return JSON.parse(await readFile(path, 'utf-8'));
		} catch {}
	}
	return undefined;
}

export async function getAllThreadIds(): Promise<string[]> {
	const threadsDir = join(DATA_ROOT, 'threads');
	const ids: string[] = [];
	let subs: string[];
	try {
		subs = await readdir(threadsDir);
	} catch {
		return [];
	}
	for (const sub of subs) {
		try {
			const files = await readdir(join(threadsDir, sub));
			ids.push(...files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')));
		} catch {}
	}
	return ids;
}

export function getAllMembers(): Promise<MemberData[]> {
	return readJsonDir<MemberData>('members');
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

export async function getMember(id: number): Promise<MemberData | undefined> {
	const path = join(DATA_ROOT, 'members', `${id}.json`);
	try {
		return JSON.parse(await readFile(path, 'utf-8'));
	} catch {
		return undefined;
	}
}

export async function getThreadsForMember(memberName: string): Promise<{ id: string; title: string; slug: string }[]> {
	const ids = await getAllThreadIds();
	const results: { id: string; title: string; slug: string; lastDate: string }[] = [];
	for (const id of ids) {
		const thread = await getThread(id);
		if (!thread) continue;
		const memberPosts = thread.posts.filter((p) => p.author === memberName);
		if (memberPosts.length === 0) continue;
		const lastPost = memberPosts.reduce((a, b) => (a.created > b.created ? a : b));
		results.push({
			id,
			title: thread.title,
			slug: threadSlug(id, thread.title),
			lastDate: lastPost.created,
		});
	}
	results.sort((a, b) => b.lastDate.localeCompare(a.lastDate));
	return results.slice(0, 10);
}

export interface Breadcrumb {
	label: string;
	href: string;
}

export async function getForumForThread(threadId: string): Promise<{ name: string; channelId: number } | undefined> {
	const forums = await getForums();
	const threadsDir = join(DATA_ROOT, 'threads');
	for (const forum of forums) {
		if (existsSync(join(threadsDir, String(forum.channelId), `${threadId}.json`))) {
			return { name: forum.name, channelId: forum.channelId };
		}
	}
}
