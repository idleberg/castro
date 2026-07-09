export interface ThreadRef {
	url: string;
	title: string;
	startedBy: string;
	createdDate: string;
	modifiedDate: string;
	nodeId: number;
	responses: number;
	views: number;
	sticky: boolean;
	closed: boolean;
}

export interface ForumData {
	url: string;
	name: string;
	channelId: number;
	isRoot?: boolean;

	totalPages: number;
	threads: ThreadRef[];
}

export interface Post {
	id: number;
	title: string;
	body: string;
	author: string;
	authorId: number;
	created: string;
	updated: string;
	attachments: { id: number; name: string; size: string; views: number; url: string }[];
}

export interface ThreadData {
	url: string;
	title: string;

	totalPages: number;
	posts: Post[];
}

export interface MemberData {
	url: string;
	id: number;
	name: string;
	title: string;

	joinDate: string;
	lastActivity: string;
	totalPosts: number;
	location: string;
}
