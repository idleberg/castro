import * as core from '@actions/core';

/**
 * Save Page Now 2 (SPN2) API.
 *
 * @see https://archive.org/details/spn-2-public-api-page-docs
 */
const SAVE_ENDPOINT = 'https://web.archive.org/save';

/** Delays before each successive retry, in milliseconds. */
const RETRY_DELAYS = [2_500, 5_000, 10_000, 20_000];

/** Timeout for a single HTTP request, in milliseconds. */
const REQUEST_TIMEOUT = 30_000;

/** Give up on a capture job after this long, in milliseconds. */
const JOB_TIMEOUT = 300_000;

/** Status codes worth retrying, everything else fails fast. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type SaveResponse = {
	url?: string;
	job_id?: string;
	message?: string;
	status?: string;
	status_ext?: string;
};

type StatusResponse = {
	status?: 'pending' | 'success' | 'error';
	original_url?: string;
	timestamp?: string;
	duration_sec?: number;
	message?: string;
	status_ext?: string;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Parses a `Retry-After` header, which is either a delay in seconds or an HTTP
 * date. Returns `undefined` for anything we can't make sense of.
 */
function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;

	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);

	const date = Date.parse(value);
	if (Number.isNaN(date)) return undefined;

	return Math.max(0, date - Date.now());
}

/**
 * Performs a request, retrying on network errors, timeouts and transient
 * status codes with an escalating backoff. The Internet Archive is a donation-
 * funded service, so we err on the side of waiting rather than hammering it.
 */
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
		if (attempt > 0) {
			const delay = RETRY_DELAYS[attempt - 1];
			core.debug(`${label}: retry ${attempt}/${RETRY_DELAYS.length} in ${delay}ms (${lastError?.message})`);
			await sleep(delay);
		}

		let response: Response;

		try {
			response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT),
			});
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			continue;
		}

		if (response.ok) return response;

		lastError = new Error(`HTTP ${response.status} ${response.statusText}`);

		if (!RETRYABLE_STATUS.has(response.status)) break;

		// A `Retry-After` beats our own backoff whenever it asks for more patience
		const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
		const backoff = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];

		if (retryAfter !== undefined && retryAfter > backoff) {
			core.debug(`${label}: honouring Retry-After of ${retryAfter}ms`);
			await sleep(retryAfter - backoff);
		}
	}

	throw new Error(`${label} failed: ${lastError?.message ?? 'unknown error'}`);
}

async function readJson<T>(response: Response, label: string): Promise<T> {
	const body = await response.text();

	try {
		return JSON.parse(body) as T;
	} catch {
		// SPN2 answers with an HTML error page when it's overloaded or blocking us
		throw new Error(`${label} returned a non-JSON response: ${body.slice(0, 200)}`);
	}
}

/** Requests a capture and returns the job ID assigned to it. */
async function requestCapture(url: string, headers: HeadersInit, ifNotArchivedWithin: string): Promise<string> {
	const body = new URLSearchParams({
		url,
		// Skips the "is this the first capture?" lookup, which we don't report on
		skip_first_archive: '1',
	});

	// Lets the Archive itself decide whether a fresh capture is warranted, which
	// is cheaper than us querying the availability API for every single URL
	if (ifNotArchivedWithin) {
		body.set('if_not_archived_within', ifNotArchivedWithin);
	}

	const response = await fetchWithRetry(SAVE_ENDPOINT, { method: 'POST', headers, body }, `Capture of ${url}`);
	const result = await readJson<SaveResponse>(response, `Capture of ${url}`);

	if (!result.job_id) {
		throw new Error(result.message ?? result.status_ext ?? 'no job ID returned');
	}

	return result.job_id;
}

/** Polls a capture job until it succeeds, fails, or we run out of patience. */
async function awaitCapture(jobId: string, headers: HeadersInit): Promise<StatusResponse> {
	const deadline = Date.now() + JOB_TIMEOUT;
	const label = `Status of ${jobId}`;

	for (let poll = 0; ; poll++) {
		// Same escalation as the retries, settling on the longest delay
		await sleep(RETRY_DELAYS[Math.min(poll, RETRY_DELAYS.length - 1)]);

		const response = await fetchWithRetry(`${SAVE_ENDPOINT}/status/${jobId}`, { method: 'GET', headers }, label);
		const result = await readJson<StatusResponse>(response, label);

		if (result.status !== 'pending') return result;

		if (Date.now() >= deadline) {
			throw new Error(`Capture job ${jobId} still pending after ${JOB_TIMEOUT / 1_000}s`);
		}
	}
}

function buildHeaders(): Record<string, string> {
	const accessKey = core.getInput('ia-access-key');
	const secretKey = core.getInput('ia-secret-key');

	if (!accessKey || !secretKey) {
		core.warning('No Internet Archive credentials provided, falling back to anonymous captures');

		return { Accept: 'application/json' };
	}

	return {
		Accept: 'application/json',
		// S3-style keys from https://archive.org/account/s3.php, the same
		// credentials the official `internetarchive` Python library uses
		Authorization: `LOW ${accessKey}:${secretKey}`,
	};
}

/** Captures a chunk of URLs one by one, returning the ones that didn't make it. */
async function submitUrls(urls: string[], headers: HeadersInit): Promise<string[]> {
	const ifNotArchivedWithin = core.getInput('if-not-archived-within');
	const rawDelay = core.getInput('request-delay');
	const requestDelay = Number(rawDelay || 10_000);
	const failures: string[] = [];

	if (!Number.isFinite(requestDelay) || requestDelay < 0) {
		throw new Error(`Invalid request-delay: ${rawDelay}`);
	}

	for (const [index, url] of urls.entries()) {
		// Authenticated accounts get 6 captures per minute, so we pace ourselves
		if (index > 0) await sleep(requestDelay);

		core.info(`Submitting ${url} to Internet Archive...`);

		try {
			const jobId = await requestCapture(url, headers, ifNotArchivedWithin);
			const result = await awaitCapture(jobId, headers);

			if (result.status !== 'success' || !result.timestamp) {
				throw new Error(result.message ?? result.status_ext ?? 'capture failed');
			}

			core.info(`Archived as https://web.archive.org/web/${result.timestamp}/${url} (${result.duration_sec}s)`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			failures.push(url);
			core.warning(`Failed to archive ${url}: ${message}`);
		}
	}

	return failures;
}

async function run(): Promise<void> {
	try {
		const urls: string[] = JSON.parse(core.getInput('url-chunk', { required: true }));

		core.info(`Processing ${urls.length} URLs...`);

		const failures = await submitUrls(urls, buildHeaders());

		core.info(`Archived ${urls.length - failures.length}/${urls.length} URLs`);

		if (failures.length > 0 && core.getBooleanInput('fail-on-error')) {
			core.setFailed(`Failed to archive ${failures.length} URLs:\n${failures.join('\n')}`);
		}
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

await run();
