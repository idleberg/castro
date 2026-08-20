import * as core from '@actions/core';
import Sitemapper from 'sitemapper';

const sitemap = new Sitemapper({
	timeout: 10_000,
});

async function run(): Promise<void> {
	try {
		await sitemap.fetch(core.getInput('sitemap-url', { required: true })).then((data) => {
			core.info(`Found ${data.sites.length} URLs in sitemap.`);
			core.setOutput('urls', JSON.stringify(data.sites));
		});
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

await run();
