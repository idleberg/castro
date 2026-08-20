import * as core from '@actions/core';
import { archiveUrl } from 'archive-url';

async function run(): Promise<void> {
	try {
		const rawChunk = core.getInput('url-chunk', { required: true });
		// const accessKey = core.getInput("ia-access-key", { required: true });
		// const secretKey = core.getInput("ia-secret-key", { required: true });

		const urls: string[] = JSON.parse(rawChunk);
		core.info(`Processing ${urls.length} URLs...`);

		for (const url of urls) {
			core.info(`Submitting ${url} to Internet Archive...`);

			const result = await archiveUrl(url, {
				timeout: 20_000,
				retries: 10,
			});

			core.info(`Result: ${JSON.stringify(result)}`);
		}
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

await run();
