import * as core from '@actions/core';
import Sitemapper from 'sitemapper';

const sitemap = new Sitemapper({
	timeout: 10_000,
});

async function run(): Promise<void> {
	try {
		const { sites } = await sitemap.fetch(core.getInput('sitemap-url', { required: true }));
		core.info(`Found ${sites.length} URLs in sitemap.`);

		const chunkSize = Number(core.getInput('chunk-size') || 50);

		if (!Number.isInteger(chunkSize) || chunkSize < 1) {
			throw new Error(`Invalid chunk-size: ${core.getInput('chunk-size')}`);
		}

		const chunks: string[][] = [];

		for (let index = 0; index < sites.length; index += chunkSize) {
			chunks.push(sites.slice(index, index + chunkSize));
		}

		core.info(`Split into ${chunks.length} chunks of up to ${chunkSize} URLs.`);
		core.setOutput('matrix', JSON.stringify(chunks));
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

await run();
