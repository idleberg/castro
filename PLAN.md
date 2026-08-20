# PLAN: GitHub Discussions Integration for Castro

**Status:** Draft for review
**Repo:** idleberg/castro
**Goal:** Add live forum functionality (read + authenticated write) backed by the GitHub Discussions API, without touching the existing static archive. Ships a first-party **Netlify** adapter plus a documented adapter contract for other runtimes (§8), and supports keeping the frontend on **GitHub Pages** with only the API hosted elsewhere (§7).

---

## 1. Guiding Constraints

1. **Legacy data is immutable.** Everything under `data/` (forums, threads, members) keeps its current ID space, file layout, and JSON Schema. No migration, no ID reuse, no write access.
2. **New content lives entirely in GitHub Discussions.** IDs are GitHub's own (`discussion.number`, `node_id`). Legacy and live content are never merged at the storage layer — only at the presentation layer, tagged by `source: 'legacy' | 'github'`.
3. **Astro stays the frontend.** Castro remains an Astro integration/theme; the "backend" is an adapter package, not a rewrite of the static core.
4. **Runtime-agnostic core, one shipped adapter.** All GitHub API/auth logic lives in a platform-neutral package built on Web Standard APIs (`Request`/`Response`, `fetch`, `crypto.subtle`) so it can run on Node, V8 isolates, and Deno. Only the **Netlify** adapter ships first-party in v1; other runtimes are served by a documented adapter contract rather than maintained packages (§8.1).
5. **No broad-scope secrets in the browser.** OAuth happens server-side (adapter function), only short-lived session tokens reach the client.
6. **Stats are additive, never rewritten.** Scraped `responses`/`views` in `data/` are the immutable base value for legacy threads. Anything that happens on GitHub (new comments, reactions used as "views" proxy, etc.) is counted _on top of_ that base at render/query time — the static JSON is never patched.
7. **The feature must be fully optional.** A site built with zero discussions config must behave exactly as it does today: fully static, no server functions, no auth, deployable to plain GitHub Pages.
8. **Static hosting stays viable _with_ discussions on.** The frontend must remain deployable to plain GitHub Pages even when discussions are enabled, with only the API surface living on a function host (Cloudflare/Netlify/Deno). Co-located (single-origin SSR) and split (static frontend + remote API) are both first-class topologies — see §7.

---

## 2. High-Level Architecture

```
┌───────────────────────────────────────────────────────────┐
│ Astro site (static, GitHub Pages or any static host)       │
│  - existing archive pages (unchanged)                      │
│  - new client islands: SignInButton, NewThreadForm,        │
│    ReplyForm, LiveThreadList                                │
└───────────────────────────────────────────────────────────┘
                │ Topology A (co-located): same-origin fetch('/api/*')
                │ Topology B (split):      cross-origin fetch(`${apiOrigin}/api/*`)
                │                          + CORS + bearer token — see §7
                ▼
┌───────────────────────────────────────────────────────────┐
│ @castro/discussions-core (platform-neutral)                │
│  - OAuth device/web flow helpers                            │
│  - session token issuing/verification (JWT, signed cookie)  │
│  - GitHub GraphQL client (discussions, comments, categories)│
│  - mapping layer: GitHub shapes → Castro view models         │
│  - stats reconciliation: base (static) + delta (live)        │
│  - rate limiting / caching abstraction (pluggable KV)        │
└───────────────────────────────────────────────────────────┘
       │  CastroAdapter ports: kv, env, rateLimit?, waitUntil?  (§8.2)
       ▼                                        ▼
┌──────────────────────────┐     ┌────────────────────────────────┐
│ @castro/adapter-netlify   │     │ community / future adapters     │
│ (Functions + Blobs)       │     │ Cloudflare, Deno, Vercel, self- │
│ FIRST-PARTY, v1           │     │ hosted — built against the spec │
└──────────────────────────┘     └────────────────────────────────┘
```

---

## 3. Technical Requirements

### 3.1 GitHub App / OAuth App setup

- Register a **GitHub App** (preferred over classic OAuth App) for fine-grained repo permissions and higher rate limits via installation tokens.
- Required permissions, repository-level: `discussions: write`, `metadata: read`. If a classic OAuth App is used instead (Q1), the equivalent is the coarse `public_repo` scope — which is precisely the argument for the App: `public_repo` grants write access to every public repo the user owns, for a feature that needs one repo's discussions.
- Store `GITHUB_APP_ID` / private key (or classic `GITHUB_CLIENT_ID`/`SECRET`) as adapter-specific env secrets — never bundled into client JS.
- Document callback URL registration per adapter, since each platform's URL shape differs (see §6 base path section).

### 3.2 Auth flow

- **Sign-in with GitHub** via OAuth Authorization Code flow — identical across platforms (two redirects + token exchange).
- Endpoints:
  - `GET /api/auth/login` → redirect to `github.com/login/oauth/authorize`
  - `GET /api/auth/callback` → exchange `code` for an access token, establish the session, return the user to the originating page
  - `POST /api/auth/logout` → clear the session and delete the KV entry
  - `GET /api/auth/session` → return the current user (id, login, avatar) for the client island to render sign-in state
- Session: short-lived signed JWT (HS256, secret from env) holding the GitHub user id/login plus a random session id. The **raw GitHub token is never in the JWT** — it lives server-side in KV keyed by that session id, so a leaked session token grants only Castro-scoped access and can be revoked by deleting one KV entry.
- **Session transport is topology-dependent** (§7.3): co-located deploys use a `HttpOnly; SameSite=Lax` cookie; split deploys must use an in-memory bearer token, because a cookie on the API origin is a third-party cookie from the static site's origin and is blocked by default in Safari and Firefox. `discussions-core` issues the same JWT in both cases and accepts it from either `Cookie` or `Authorization: Bearer`; only the transport differs.

### 3.3 Read API (GraphQL)

- Base query shape:
  ```graphql
  repository(owner: $owner, name: $name) {
    discussions(categoryId: $categoryId, first: $first, after: $after) {
      nodes {
        id number title body bodyHTML createdAt
        author { login avatarUrl }
        comments(first: $comments) { nodes { id body bodyHTML createdAt author { login avatarUrl } } }
      }
    }
  }
  ```
- Cache 60–300s per adapter's KV/edge cache — see §3.6, where the cache is a hard requirement rather than an optimization.
- Mapping layer converts discussion → `LiveThread`/`LivePost` (never merged into `ThreadData`/`Post` types — kept structurally distinct, joined only at render time, see §5).
- `first`/`last` arguments must stay within 1–100, and a single call may not exceed 500,000 nodes — a constraint on how deeply the mapping layer may nest comments in one query.

### 3.4 Write API

- `createDiscussion(repositoryId, categoryId, title, body)` — new thread; `addDiscussionComment(discussionId, body)` — reply. Both executed as the signed-in user (GitHub App user-to-server token), so posts carry the real GitHub identity rather than a service account.
- Server-side validation: length limits, sanitization, CSRF protection, per-user rate limiting independent of GitHub's own limits.
- Prefer GitHub's own `bodyHTML` for rendering over client-side markdown parsing — it is already sanitized by GitHub and matches how the content appears on github.com. Raw `body` is kept for edit forms.
- GitHub's own write limits (80/min, 500/hr content creation) are per-user and far above human posting rates — our own limiter, not GitHub's, is the binding constraint on writes (§3.6).
- CSRF strategy differs per topology: co-located relies on `SameSite` cookies plus a double-submit token; split relies on an `Origin`/`Referer` allowlist check, since bearer tokens are not ambiently attached by the browser (§7.4).

### 3.5 Category mapping

- Sub-forums map 1:1 to Discussion categories, configured explicitly (not inferred) via `categoryMap` in config.
- **Repo admins must pre-create the categories** to match Castro's forum structure; Castro reads `categoryId` from config and never creates categories itself. Setup docs must state this as a prerequisite, since a missing category surfaces as an opaque GraphQL error at post time rather than at build time.
- Validate configured category IDs against the repo at startup (or first request) and fail loudly, so a typo'd ID is caught before a user loses a written post to it.

### 3.6 GraphQL rate limits — a load-bearing constraint, not a footnote

GitHub's GraphQL API has no anonymous tier: every request must carry a token. That single fact drives the whole design below, because it means anonymous site visitors are served from _our_ token, not their own.

**The limits** (verified against GitHub docs, Aug 2026):

|                                    | Limit                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| GitHub App installation token      | 5,000 points/hr, scaling to 12,500 by repo/user count                              |
| User access token (user-to-server) | 5,000 points/hr **per user**                                                       |
| Query cost                         | Connections needed ÷ 100, rounded, min 1 — in practice **1 point** for our queries |
| Secondary: endpoint                | 2,000 points/min; 100 concurrent requests                                          |
| Secondary: content creation        | 80/min, 500/hr                                                                     |
| Node ceiling                       | 500,000 nodes/call; `first`/`last` ∈ 1–100                                         |

Because our queries round down to the 1-point floor, the hourly budget is best read as "≈5,000 queries."

#### 3.6.1 Two budgets, and which one is scarce

- **Anonymous readers all share one installation-token bucket.** This is the scarce resource, and it is scarce _because_ it is shared — one bucket for the entire audience.
- **Signed-in users each have their own 5,000/hr.** For forum browsing that is effectively unlimited (~83 sustained uncached queries/minute for an hour to exhaust it).

The scaling intuition therefore inverts: anonymous readers are the expensive ones, signed-in users are close to free. Two rules follow:

1. **Token selection:** on a cache miss, fill using the requesting user's token when one is present; fall back to the installation token only for anonymous traffic. This keeps the shared bucket serving only the traffic that has no alternative.
2. **Caching is global, regardless of who asks.** Live discussion content is public and identical for every viewer, so one cache serves everyone; only the _fill_ is token-sensitive. Note honestly in the docs that a cache fill spends one user's point on everyone else's behalf — negligible at one fill per minute, but it should not be silent.

#### 3.6.2 The failure mode to design against

§4.5's client-side stats hydration fires a request per page view. Uncached, ~5,000 page views/hour exhausts the shared bucket and live counts break site-wide until the reset — one aggregator link would do it. The cache granularity is what decides this, and the difference between the two designs is roughly two orders of magnitude:

- ❌ **Per-thread cache keys.** A crawler walking an archive of thousands of thread pages triggers one cold query per thread.
- ✅ **One coarse poll.** A single "all live discussions" query per 60s, with page-level stats served from KV. ~60 points/hour, with enormous headroom.

**Requirement: live reads are served from a single coarse cached poll, never per-thread queries.** This is a correctness constraint on Milestone 2, not a tuning exercise for later.

#### 3.6.3 Error handling gotchas

- **Exceeding the primary limit returns HTTP 200**, with a `RATE_LIMITED` entry in the `errors` array and `x-ratelimit-remaining: 0`. Any client branching on `response.ok` sails straight past it into a missing `data`. Secondary limits return 200 _or_ 403, so both paths need handling. The GraphQL client must treat a 200 as potentially-failed — not the default assumption of most `fetch` wrappers.
- **A user's 5,000/hr is not private to Castro.** Per GitHub: "This rate limit is combined with any requests that another GitHub App or OAuth app makes on that user's behalf and any requests that the user makes with a personal access token." A developer-heavy audience — likely, for an archive being revived on GitHub — can arrive with a partly-spent budget from `gh` CLI, CI, or other apps. So a signed-in user can hit a limit **through no fault of Castro**.
- Therefore the two conditions need **distinct, non-conflatable error messages**: "GitHub's rate limit for your account is exhausted (shared with other GitHub apps you use)" vs. "this site is over its API budget, live counts are temporarily unavailable." Merging them produces bug reports nobody can act on.
- Every rate-limit failure degrades to `responsesBase` per §4.5 — the archive stays readable.

---

## 4. Stats Reconciliation (Views/Responses)

### 4.1 The problem

`ThreadRef.responses` and `ThreadRef.views` (in `src/lib/types.ts`) are frozen counts from the vBulletin scrape. Once a thread can receive live GitHub comments, a naive UI showing only the static number becomes wrong the moment someone replies. We must never rewrite the static JSON (constraint #6), but the displayed number has to move.

### 4.2 Model

Every thread-like entity rendered to the user gets a **derived stat**, computed at request/build time, never persisted back to `data/`:

```ts
interface ThreadStats {
	responsesBase: number; // from data/ (0 for GitHub-native threads)
	responsesLive: number; // count of live GitHub comments, 0 if discussions disabled
	responsesTotal: number; // responsesBase + responsesLive
	viewsBase: number; // from data/ (0 for GitHub-native threads)
	viewsLive: number; // best-effort proxy, see 4.3
	viewsTotal: number;
}
```

- For **legacy threads with no linked discussion**: `responsesLive`/`viewsLive` stay 0, `Total === Base`, i.e. today's behavior, byte-for-byte.
- For **legacy threads linked to a discussion** (opt-in "continue this thread on GitHub" feature — see §4.4): `responsesTotal = responsesBase + live comment count` fetched at render time.
- For **GitHub-native threads** (created entirely through Discussions): `responsesBase = 0`, `responsesTotal = live comment count`.

### 4.3 "Views" don't exist on GitHub Discussions

GitHub's API has no view-count equivalent. Options, to decide in Milestone 0:

- **(a) Drop "views" for live/linked threads**, show "responses" only, with a UI note ("view counts unavailable for live discussions").
- **(b) Track views ourselves**, incrementing a counter in the adapter's KV on each thread page load (cheap, but inflates on refresh/bots unless deduped by session/IP+day).
- Recommendation: ship **(a)** in v1, revisit **(b)** later as a "Milestone 10 — stretch" item since it needs its own abuse-mitigation design (bot traffic, crawlers).

### 4.4 Linking a legacy thread to a live discussion

Not required for v1, but the architecture should allow it later: a small `data/discussion-links.json` (or a field the site owner adds manually) mapping legacy `threadId → discussionNumber`, so a legacy archive thread can say "12 replies (8 archived + 4 new) — continue the conversation" and deep-link into the live discussion. Kept as an explicit, opt-in, manually curated mapping — never auto-matched by title/author heuristics, to avoid silently attaching live content to the wrong legacy thread.

### 4.5 Where the merge happens

Reconciliation is a pure function in `discussions-core` (`computeThreadStats(base, live)`) — deliberately pure so it can run in either place. When disabled, `src/lib/data.ts` is untouched and this function is never imported — keeping the static build path dependency-free of any GitHub/network code (important: we don't want `astro build` for a plain archive to require network access or secrets).

Where it _runs_ depends on topology:

- **Co-located (SSR):** called from the Astro data layer (`src/lib/data.ts`) at request time, so the server-rendered HTML already carries `responsesTotal`.
- **Split (static frontend):** there is no request-time render, so the static HTML is built with `responsesBase` only. A small client island fetches `GET /api/discussions/stats?threads=…` (batched per page, not per thread) and calls the same `computeThreadStats` in the browser to patch the numbers in after hydration.

Consequence to accept explicitly: on a split deploy, first paint shows archived counts, which then tick up once the stats response lands. Counts must therefore be rendered in a way that tolerates changing (fixed-width/`tabular-nums`, no layout shift), and must degrade to `responsesBase` — not to an error or a spinner — if the API is unreachable. This keeps the static archive fully readable when the function host is down, which is a property worth having regardless.

---

## 5. Making Discussions Optional: Integration Architecture

### 5.1 Decision: split into a second, optional Astro integration

Rather than growing `castro()`'s single config object with more and more unrelated concerns, add a **second integration**, `castroDiscussions()`, exported from a new subpath or separate package `@castro/discussions`. Rationale:

- `castro()` today (`.castro/integration.ts`) does three unrelated things: site/base resolution, env schema, data symlinks. All of that is required even for a read-only archive. Discussions is a fundamentally different concern (auth, server functions, secrets) and pulling it into the same function makes the "do nothing" path harder to guarantee.
- A separate integration means: **not installing/registering it means zero behavior change, zero new dependencies pulled into the static build, zero new env vars required.** This is the cleanest way to guarantee constraint #7.
- It also mirrors how official Astro integrations do optional add-ons (e.g. `@astrojs/db`, `@astrojs/react` next to `@astrojs/starlight`) — familiar pattern for users.

```js
// astro.config.mjs — discussions OFF (today's behavior, unchanged)
import castro from 'castro';

export default defineConfig({
	integrations: [castro({ title: 'Forum Archive', githubPages: true })],
});
```

```js
// astro.config.mjs — discussions ON
import castro from 'castro';
import castroDiscussions from '@castro/discussions';

export default defineConfig({
	integrations: [
		castro({ title: 'Forum Archive', deploy: { provider: 'netlify' } }),
		castroDiscussions({
			repo: 'owner/name',
			categoryMap: { 12345: 'General', 67890: 'Support' },
			adapter: 'netlify',
		}),
	],
});
```

### 5.2 How the two integrations cooperate

- `castroDiscussions()` hooks `astro:config:setup` to: (a) verify that an API surface is reachable one way or the other — **either** an SSR adapter is configured (co-located topology) **or** `apiOrigin` is set (split topology, §7). Fail the build with a clear error only if _neither_ is present; `output: 'static'` plus `apiOrigin` is a fully supported configuration, not an error. (b) inject its own env schema (`GITHUB_APP_ID`, session secret, etc.) via `envField`; (c) in the co-located topology only, register the `/api/auth/*` and `/api/discussions/*` server endpoints (as injected routes via `injectRoute`, not hand-authored files, so users don't need to scaffold anything). In the split topology no routes are injected — the API is a separate deployable owned by the adapter package (§7.5), and the integration's only job is to bake `apiOrigin` into the client islands.
- `castro()` core gains a **feature flag it can read but doesn't own**: it checks `import.meta.env` or a shared config symbol to know whether to render the "Live Discussions" nav entry / client islands, but the actual data-fetching code for discussions is dynamically imported only when enabled, so tree-shaking drops it entirely from static-only builds.
- Both integrations read/write a small shared context object (Astro's `config.integrations` order or a documented `castro:discussions:*` virtual module) so `castro()`'s `src/lib/data.ts` can optionally call into `discussions-core`'s `computeThreadStats` without a hard dependency — implemented as an optional peer dependency, dynamically `import()`ed, guarded by `try/catch` + presence check.

### 5.3 Why not just extend `castro()`'s existing config object

Considered and rejected for v1:

- Forces every user (even static-only archives) to have the discussions types/schema in their type surface.
- Makes "is the network/auth code included in my static build" a matter of dead-code elimination trust rather than a structural guarantee (import boundary).
- Versioning: discussions will iterate faster/break more (new adapters, new GitHub API shapes) than the stable archive core; separate package = separate semver line.

---

## 6. GitHub Pages Base-Path Logic: Breaking Change Required

### 6.1 Current behavior (as-is, `.castro/integration.ts`)

```ts
function resolveSite(config, githubPages?: boolean) {
	if (config.site) return {};
	if (githubPages && process.env.GITHUB_ACTIONS) {
		const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
		const isUserRepo = repo === `${owner}.github.io`;
		return { site: `https://${owner}.github.io`, ...(!isUserRepo && { base: `/${repo}` }) };
	}
	return { site: `http://localhost:${config.server.port}` };
}
```

This is GitHub-Pages-only: a single boolean, hardcoded env var names, hardcoded URL shape. It works today because Castro has exactly one deployment target in mind.

### 6.2 Why this breaks once other providers are in scope

- **Netlify**: no subpath-per-repo convention; site is served from a custom/`*.netlify.app` domain at `/`. Env vars: `URL`, `DEPLOY_PRIME_URL`, `CONTEXT`.
- **Cloudflare Pages**: served at `/` on `*.pages.dev` or a custom domain. Env vars: `CF_PAGES_URL`, `CF_PAGES_BRANCH`.
- **Deno Deploy**: served at `/` on `*.deno.dev` or custom domain. Env var: `DENO_DEPLOYMENT_ID` (no full URL provided directly; project domain is knowable from project name).
- None of these need a `base` subpath the way GitHub Pages project sites do. A boolean `githubPages` flag can't express "which provider am I on," so auto-detection logic would need a provider-specific branch per host, and the option name itself (`githubPages: true`) stops making sense as "the" special case.

### 6.3 Proposed new API (breaking change, intentional)

Replace the single boolean with an explicit, extensible provider config:

```ts
interface CastroConfig {
	title: string;
	description?: string;
	keywords?: string[];
	// BREAKING: replaces `githubPages?: boolean`
	deploy?: {
		provider: 'github-pages' | 'netlify' | 'cloudflare-pages' | 'deno-deploy' | 'auto' | 'custom';
		/** Only used when provider === 'custom', or to override auto-detection. */
		site?: string;
		base?: string;
	};
}
```

Note that `deploy.provider` describes **where the static site is served from**, and nothing else. It deliberately does _not_ imply where the API lives — that is `castroDiscussions({ apiOrigin })`'s concern (§7.2). `deploy: { provider: 'github-pages' }` combined with a Cloudflare-hosted API is a valid and expected pairing.

- `provider: 'auto'` (default when `deploy` is present without a provider) inspects env vars in a fixed priority order (`GITHUB_ACTIONS` → `CF_PAGES_URL` → `URL`/`DEPLOY_PRIME_URL` (Netlify) → `DENO_DEPLOYMENT_ID`) and resolves `site`/`base` per matched provider's own rules (GitHub Pages: subpath rule as today; the other three: no subpath, full URL from the provider's own env var).
- Omitting `deploy` entirely: falls back to today's `localhost` dev default — no behavior change for users who don't configure it.
- `githubPages: true` is **removed**, not soft-deprecated with a shim — this is called out explicitly as a breaking change in the changelog/migration guide, because keeping a parallel legacy boolean alongside a new `deploy` object invites ambiguous/conflicting configs (what happens if both are set?).
- Migration is a one-line change: `githubPages: true` → `deploy: { provider: 'github-pages' }`.

### 6.4 Relationship to `castroDiscussions()`

`castroDiscussions()` reads the resolved `site`/`base` from `castro()` (via Astro's shared `config` object at `astro:config:setup` time, integrations run in order). Two distinct URLs are derived from it, and conflating them is the mistake to avoid:

- **OAuth callback URL** — always on the _API_ origin: `${apiOrigin ?? site + base}/api/auth/callback`. This is the URL registered with GitHub.
- **Post-login return URL** — always on the _site_ origin: `${site}${base}`. In a split deploy the callback lands on the API host, which then redirects back here to hand the session to the frontend (§7.3).

In the co-located topology the two collapse into one, which is why the original single-URL formulation looked sufficient. `deploy.provider` still has to resolve unambiguously and early, for the return URL and the CORS allowlist — which is why it can't stay a GitHub-Pages-only boolean.

---

## 7. Split Deployment: Static Frontend on GitHub Pages + Remote API

### 7.1 Why this topology matters

The archive is already on GitHub Pages: free, permanent, no account to maintain, no cold starts, nothing to bill. Requiring a full SSR migration in order to add a comment box would trade all of that away for a feature that touches a small fraction of the page surface. The split topology keeps the archive exactly where it is and puts only the dynamic surface (auth + read/write of live discussions) on a function host.

This makes constraint #7 stronger than "discussions-off still works on Pages": **discussions-on also works on Pages.** For a project whose whole premise is a preserved vBulletin archive, hosting durability is a feature, and one that shouldn't be given up to add a forum.

Both topologies ship in v1:

|                   | **A. Co-located**                 | **B. Split**                                |
| ----------------- | --------------------------------- | ------------------------------------------- |
| Frontend          | SSR on Netlify (or any adapter)   | Static on GitHub Pages (or any static host) |
| API               | Same origin, `/api/*`             | `apiOrigin`, cross-origin                   |
| Astro `output`    | `'server'` / `'hybrid'` + adapter | `'static'`, no adapter                      |
| Session transport | `HttpOnly` cookie                 | In-memory bearer token                      |
| CSRF defense      | `SameSite` + double-submit        | `Origin` allowlist                          |
| Live stats        | Server-rendered                   | Hydrated client-side (§4.5)                 |
| Cost of frontend  | Provider's pricing                | Free, permanent                             |

### 7.2 Configuration

```js
// astro.config.mjs — split: frontend on GitHub Pages, API on Netlify (recommended setup)
import castro from 'castro';
import castroDiscussions from '@castro/discussions';

export default defineConfig({
	// no SSR adapter, output stays 'static'
	integrations: [
		castro({ title: 'Forum Archive', deploy: { provider: 'github-pages' } }),
		castroDiscussions({
			repo: 'owner/name',
			categoryMap: { 12345: 'General', 67890: 'Support' },
			adapter: 'netlify',
			/** Split topology: absolute origin of the deployed API. Omit for co-located. */
			apiOrigin: 'https://castro-api.netlify.app',
		}),
	],
});
```

- `apiOrigin` present ⇒ split topology; absent ⇒ co-located, and an SSR adapter becomes mandatory (§5.2).
- `apiOrigin` is a public value (it ends up in client JS by design) — it is _not_ a secret and must not be sourced from a secret env var.
- The API side needs the inverse: `ALLOWED_ORIGINS` (the static site's origin, e.g. `https://owner.github.io`) as a server-side env var, used for both CORS and CSRF checks. Both sides must be configured; a mismatch is the single most likely setup failure and needs a first-class error message.

### 7.3 Auth across origins

This is the substantive design difference, not a config detail. A `Set-Cookie` from `castro-api.netlify.app` is a third-party cookie relative to `owner.github.io`: blocked by default in Safari (ITP) and Firefox (Total Cookie Protection), and subject to Chrome's ongoing restrictions. A cookie-based session would appear to work for the developer testing in Chrome and silently fail for a large share of real users. So:

1. Client island opens `${apiOrigin}/api/auth/login?return_to=<site origin + base>`. The API validates `return_to` against `ALLOWED_ORIGINS` (open-redirect prevention) and stores it in the OAuth `state` payload.
2. GitHub redirects to `${apiOrigin}/api/auth/callback` — the callback is registered on the API origin, so GitHub never needs to know about the Pages origin.
3. The API exchanges the code, stores the real GitHub token in KV, mints the session JWT, and redirects to `return_to#session=<jwt>` — **fragment, not query string**, so the token never lands in Referer headers, server logs, or CDN access logs.
4. The client island reads the fragment, immediately clears it via `history.replaceState`, and holds the JWT **in memory only**. Not `localStorage` (XSS-exfiltratable and persists across tabs), not a cookie (blocked).
5. Every subsequent call sends `Authorization: Bearer <jwt>`; the API sets `Access-Control-Allow-Origin` to the matched allowed origin (never `*` once credentials are involved) and handles preflight for `POST`/`Authorization`.

Accepted trade-off: an in-memory token means **sign-in does not survive a page reload or a new tab** — the user is silently re-authenticated via a `prompt=none`-style redirect, or clicks sign-in again. This is worse UX than the co-located cookie flow, and it is the honest price of static hosting. Document it plainly rather than papering over it with `localStorage`.

### 7.4 CSRF and abuse surface

With bearer tokens the browser attaches nothing ambiently, so classic CSRF largely evaporates — but the API is now a public, unauthenticated-readable endpoint on the internet:

- Enforce `Origin` allowlist on all state-changing requests; reject rather than silently `*`.
- Rate-limit by session **and** by IP, since anonymous reads are open (§9 Q5).
- Preflight caching (`Access-Control-Max-Age`) to avoid an `OPTIONS` round-trip per interaction on a cross-origin path.

### 7.5 Packaging implication

In the split topology an adapter must be **independently deployable**, not merely importable from an Astro SSR build: it ships its own entrypoint (`netlify/functions/api.ts`) plus a deploy config, so a user can `netlify deploy` the API on its own with no Astro build involved. This is a real constraint on the adapter design (Milestone 3) and on the adapter contract (§8.2) — an adapter that only works as an Astro SSR handler cannot serve topology B, so both entry paths must be built from the start rather than retrofitted.

---

## 8. Package Layout

```
packages/
  discussions-core/         # @castro/discussions-core — platform-neutral logic
    src/
      auth.ts
      github-client.ts
      mapping.ts             # GitHub shapes -> LiveThread/LivePost
      stats.ts               # computeThreadStats(base, live)
      cache.ts
      rate-limit.ts
      types.ts
    test/
  adapter-netlify/           # @castro/adapter-netlify — the only first-party adapter in v1
    src/handler.ts           # Astro SSR entry (topology A)
    netlify/functions/       # standalone deployable entry (topology B)
    src/kv.ts                # Netlify Blobs implementation of the KV port
  castro-discussions/        # @castro/discussions — the optional Astro integration
    src/integration.ts       # injectRoute for /api/*, env schema, adapter requirement check
    src/components/          # SignInButton, NewThreadForm, ReplyForm, LiveThreadList
  castro (existing package)
    .castro/integration.ts   # gains `deploy` config (breaking), stays discussions-agnostic
```

### 8.1 Adapter scope: Netlify first-party, everything else specified

**Decision:** ship exactly one first-party adapter (Netlify) in v1, and publish a written **adapter contract** so Cloudflare/Deno/Vercel/self-hosted adapters can be built by anyone — including us later — without changing `discussions-core`.

Rationale: three adapters means three sets of accounts, three CI setups, three lots of platform drift to track, all for platforms this project doesn't use. Maintaining an adapter you don't run yourself means shipping code you can't verify is still working. One adapter that is genuinely exercised in production beats three that rot, and a stable documented port surface is what actually makes the others cheap to add.

Cost of deferring: the "runtime-agnostic core" claim (constraint #4) goes untested against a second runtime, and it is easy to leak Node-isms into `discussions-core` when only Node-flavored Netlify Functions consume it. Mitigations, both cheap:

- Constrain `discussions-core` to Web Standard APIs only (`Request`/`Response`/`fetch`/`crypto.subtle`, no `node:` imports, no `Buffer`), enforced by lint rule + a `workerd`-condition build check in CI.
- Run the core's unit tests under both Node and a V8-isolate-like environment (e.g. `vitest` with `@cloudflare/vitest-pool-workers` or plain `miniflare`) — no Cloudflare account needed, it runs locally.

### 8.2 The adapter contract

An adapter is anything that supplies these four ports and one entrypoint. `discussions-core` depends on the interfaces, never on a platform SDK:

```ts
interface CastroAdapter {
	/** Session + response cache. Netlify Blobs / Workers KV / Deno KV / Redis. */
	kv: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** Secrets and config. Reads platform env; must not be bundled client-side. */
	env: (key: string) => string | undefined;
	/** Optional: platform-native rate limiting; core falls back to a KV-based limiter. */
	rateLimit?: (key: string, limit: number, windowSeconds: number) => Promise<boolean>;
	/** Optional: work that may outlive the response (cache warming, view counters). */
	waitUntil?: (promise: Promise<unknown>) => void;
}

/** The single entrypoint every adapter wraps in its platform's handler shape. */
declare function createHandler(
	config: DiscussionsConfig,
	adapter: CastroAdapter,
): (request: Request) => Promise<Response>;
```

A new adapter is then roughly: implement `kv` over the platform's store, map its handler signature to `(Request) => Response`, ship a deploy config. Target: **under 150 lines**, and that number is the design constraint — if a platform needs more than that, the port surface above is wrong and should be widened rather than worked around in the adapter.

The contract is documented and versioned as part of the public API (`docs/discussions/writing-an-adapter.md`, Milestone 8), with a shared conformance test suite exported from `discussions-core` (`@castro/discussions-core/conformance`) that any adapter can run against its own KV implementation to prove it behaves. That suite is what makes third-party adapters trustworthy without us testing them, and it's cheap to write once while building Netlify.

---

## 9. Work Breakdown (Chunking)

### Milestone 0 — Design finalization (no code)

- [ ] Confirm GitHub App vs OAuth App
- [ ] Confirm stats approach: drop live "views" (§4.3a) vs build view-tracking (§4.3b)
- [ ] Confirm `deploy.provider` naming/values and auto-detection priority order
- [ ] Confirm breaking-change policy: major version bump for `castro`, changelog + migration note
- [ ] Confirm the split topology (§7) is the primary target: GitHub Pages frontend + Netlify API
- [ ] Confirm anonymous-read vs. sign-in-to-read in light of the shared-bucket cost (§3.6.1, Q5)
- [ ] Freeze the adapter contract surface (§8.2) before Milestone 2 hardens around it
- [ ] Write `docs/adr/0001-github-discussions.md`, `docs/adr/0002-deploy-provider-config.md`, `docs/adr/0003-split-deployment-topology.md`

### Milestone 1 — `deploy` config breaking change (independent, ship first)

- [ ] Replace `githubPages?: boolean` with `deploy?: { provider, site?, base? }` in `.castro/integration.ts`
- [ ] Implement `auto` provider detection (GitHub Pages, Netlify, Cloudflare Pages, Deno Deploy)
- [ ] Update README/docs, add migration note + version bump
- [ ] This can ship independently of discussions, unblocking §6.4 later

### Milestone 2 — `discussions-core` package

- [ ] Scaffold, OAuth/GitHub App token exchange, session signing (`jose`)
- [ ] GraphQL client: read (discussions/comments/categories) + write (create/comment) mutations
- [ ] Rate-limit handling per §3.6: treat HTTP 200 with a `RATE_LIMITED` error as a failure, handle 403 secondary limits, respect `x-ratelimit-remaining`
- [ ] Token selection rule — prefer the requesting user's token on cache miss, installation token only for anonymous (§3.6.1)
- [ ] Single coarse cached poll for live reads; assert no per-thread query path exists (§3.6.2)
- [ ] Distinct error types for per-user vs. shared-bucket exhaustion, surfaced as distinct UI copy (§3.6.3)
- [ ] Include `rateLimit { cost remaining resetAt }` in dev builds so query cost is measured, not assumed
- [ ] Mapping layer: GitHub → `LiveThread`/`LivePost`
- [ ] `computeThreadStats(base, live)` per §4
- [ ] `CastroAdapter` port interfaces per §8.2 (cache, rate-limit, env, waitUntil) — implementations injected by adapters
- [ ] Session JWT accepted from either `Cookie` or `Authorization: Bearer` (§3.2)
- [ ] Web-Standard-only constraint: lint rule banning `node:` imports/`Buffer`, CI build under a `workerd` condition (§8.1)
- [ ] Unit tests incl. stats reconciliation edge cases (0 base, 0 live, both, linked vs native), run under both Node and an isolate-like environment
- [ ] Exported conformance suite (`@castro/discussions-core/conformance`) for third-party adapter KV implementations

### Milestone 3 — Netlify adapter (the only first-party adapter in v1)

- [ ] Netlify Functions handler, Netlify Blobs for sessions/cache
- [ ] **Both** entrypoints: Astro SSR handler (topology A) _and_ standalone deployable function (topology B) — §7.5
- [ ] `netlify.toml` example for each topology, secrets docs, `netlify dev` instructions
- [ ] Run the conformance suite against the Blobs KV implementation
- [ ] Serves as the reference implementation the adapter spec is written from

### Milestone 4 — Adapter contract & spec (replaces the Cloudflare/Deno adapter milestones)

- [ ] Finalize and document `CastroAdapter` (§8.2) as public, semver-tracked API
- [ ] `docs/discussions/writing-an-adapter.md` — port-by-port walkthrough, conformance suite usage, worked Cloudflare Workers sketch as the illustrative example (documented, not shipped/maintained)
- [ ] Confirm the <150-line target holds by prototyping one non-Netlify adapter against the spec _without_ deploying or publishing it — this is the real test that the port surface is right
- [ ] Community-adapter policy: link out from README, no support commitment

### Milestone 5 — `@castro/discussions` Astro integration

- [ ] `injectRoute` for `/api/auth/*`, `/api/discussions/*` (co-located topology only, §5.2)
- [ ] Accept `apiOrigin`; fail fast with a clear error only when _neither_ an SSR adapter nor `apiOrigin` is present
- [ ] Env schema for GitHub App id/secret, session secret, repo, categoryMap, `ALLOWED_ORIGINS`
- [ ] Client islands (`client:idle` by default, `client:load` only for SignInButton): SignInButton reads `/api/auth/session` and renders avatar/logout or "Sign in with GitHub"; NewThreadForm and ReplyForm render disabled-with-prompt when signed out, never hidden entirely (a hidden reply box reads as "this thread is closed")
- [ ] Split-topology client: fragment-based session handoff, in-memory token, bearer auth, CORS-aware fetch wrapper (§7.3)
- [ ] Client-side stats hydration island with graceful `responsesBase` fallback (§4.5)
- [ ] `/discuss/`, `/discuss/[number]` routes, visually consistent with existing `Post.astro` styling but structurally separate component tree. The URL-space split from legacy `/thread/` is deliberate and mirrors constraint #2: GitHub-backed content is never addressable under the archive's ID space, so a legacy permalink can never resolve to live content or vice versa
- [ ] Live content renders _alongside_ the static archive listing (e.g. a "Live Discussions" section/tab), never interleaved into it
- [ ] Verify: uninstalling this package returns the site to byte-identical static output

### Milestone 6 — Split-deployment end-to-end

- [ ] Reference deployment: Astro static → GitHub Pages, API → Netlify, wired via `apiOrigin`
- [ ] CORS preflight + `Origin` allowlist verified against the real Pages origin
- [ ] Verify sign-in works in Safari and Firefox with third-party cookies blocked (the whole point of §7.3 — test it explicitly, in those browsers, not just Chrome)
- [ ] Verify the site remains fully readable with the API host down
- [ ] Actionable error message for the `apiOrigin` ↔ `ALLOWED_ORIGINS` mismatch case

### Milestone 7 — Security & hardening

- [ ] CSRF review (both topologies), content sanitization audit, secrets rotation docs
- [ ] Open-redirect review of `return_to` validation (§7.3 step 1)
- [ ] Rate limit tuning; IP-based limits for anonymous cross-origin reads
- [ ] Abuse handling: defer to native GitHub Discussions moderation for v1

### Milestone 8 — Documentation

- [ ] `docs/discussions/overview.md` — architecture, ID separation, stats model, both topologies
- [ ] `docs/discussions/setup-github-app.md`
- [ ] `docs/discussions/deploy-netlify.md` — co-located and split variants
- [ ] `docs/discussions/deploy-github-pages-split.md` — the recommended path
- [ ] `docs/discussions/writing-an-adapter.md` (from Milestone 4)
- [ ] `docs/discussions/configuration.md`
- [ ] `docs/migration/v-next-deploy-config.md` — `githubPages: true` → `deploy.provider`
- [ ] `docs/discussions/troubleshooting.md` — CORS, origin mismatch, blocked-cookie symptoms, both rate-limit conditions (§3.6.3)
- [ ] `docs/discussions/rate-limits.md` — budget model, caching requirement, what users see when a limit is hit
- [ ] README updates: "Live Discussions (optional)" section + migration callout

### Milestone 9 — Release

- [ ] Changesets across `castro`, `@castro/discussions`, `@castro/discussions-core`, `@castro/adapter-netlify`
- [ ] Example template repo: GitHub Pages frontend + Netlify API (split topology)
- [ ] Mark discussions packages `0.x`/experimental; `castro`'s `deploy` change ships as its next major

### Milestone 10 — Stretch (post-v1)

- [ ] Live view-count tracking (§4.3b) with bot/dedup mitigation
- [ ] Legacy-thread-to-discussion linking UI (§4.4) beyond manual JSON mapping
- [ ] First-party Cloudflare/Deno adapters, if demand appears or the spec proves insufficient

---

## 10. Open Questions (pick up in Claude Code)

1. **Auth app type** — GitHub App vs classic OAuth App? (App recommended: fine-grained perms, higher rate limit, more setup.)
2. **Views stat** — drop entirely for live/linked threads (§4.3a, simpler, honest) or build a self-hosted view counter (§4.3b, needs bot/dedup mitigation)?
3. **Stats display** — for a legacy thread linked to a live discussion, should the UI show a combined total ("12 replies") or a broken-down count ("8 archived + 4 new")? Affects `ThreadStats` consumption in components.
4. **Thread linking (§4.4)** — is manual `data/discussion-links.json` curation acceptable for v1, or is auto-detection (e.g. matching by title) worth the risk despite the recommendation against it?
5. **Read access** — anonymous read for live discussions, sign-in required only to post? Confirm as the default. Note the cost: anonymous reads all share one installation-token bucket (§3.6.1), and requiring sign-in for live reads would eliminate that shared-bucket risk entirely. Recommendation is still anonymous-read — an archive's value is open readability, and correct caching makes the shared bucket a non-issue — but the trade is real and should be decided deliberately, not by default.
6. **Repo scope** — must Discussions live in the same repo as the archive, or should the target repo be configurable separately (e.g. a private "content" repo vs public archive repo)?
7. **`deploy.provider` values** — confirm the four provider values and the `auto`-detection priority order in §6.3, or reorder/rename (e.g. should Vercel be added to the list now rather than later)? Note `deploy.provider` still lists platforms for which no adapter ships — that's fine, since it only describes _static site_ hosting (§6.3), but the docs must not imply an adapter exists for each.
8. **Breaking change timing** — is a major version bump for `castro` (removing `githubPages: true`) acceptable now, decoupled from the discussions feature's own timeline, i.e. can Milestone 1 ship standalone first?
9. **Moderation** — defer entirely to GitHub's native Discussions moderation tools for v1, or is an in-app hide/report affordance required at launch?
10. **Category-to-forum granularity** — is strict 1:1 forum↔category mapping sufficient, or do some sub-forums need to fan out into multiple categories (or vice versa)?
11. **Topology default** — should the docs present split (Pages + Netlify) as _the_ recommended path with co-located as the advanced option, or the reverse? Affects README framing and the example template repo.
12. **Session persistence** — is "sign-in doesn't survive a reload" (§7.3) acceptable for v1, or does that UX cost justify offering a co-located deploy as the recommended path instead?
13. **Adapter contract stability** — should `CastroAdapter` (§8.2) be frozen as public semver'd API at v1, or explicitly marked unstable until a second adapter exists to validate it?

---

## 11. Effort Estimate (rough, solo dev)

| Milestone                                                                        | Estimate           |
| -------------------------------------------------------------------------------- | ------------------ |
| 0. Design finalization                                                           | 0.5–1 day          |
| 1. `deploy` config breaking change                                               | 1 day              |
| 2. discussions-core (incl. stats, ports, conformance suite, rate-limit handling) | 5.5–6.5 days       |
| 3. Netlify adapter (both entrypoints)                                            | 2 days             |
| 4. Adapter contract & spec                                                       | 1.5 days           |
| 5. `@castro/discussions` integration + frontend (both topologies)                | 4.5 days           |
| 6. Split-deployment end-to-end                                                   | 1.5 days           |
| 7. Security hardening                                                            | 1.5–2 days         |
| 8. Documentation                                                                 | 3.5 days           |
| 9. Release                                                                       | 0.5 day            |
| **Total (Milestones 0–9)**                                                       | **~22–24 days**    |
| 10. Stretch (view tracking, thread linking, more adapters)                       | +3–5 days, post-v1 |

Net effect of the two amendments: dropping the Cloudflare and Deno adapters saves ~3.5 days, but supporting the split topology properly (auth redesign, client-side stats hydration, cross-browser verification, extra docs) costs ~6.5, plus ~1.5 for the adapter spec and conformance suite. The split-topology work is what buys the GitHub Pages frontend — the thing that makes this feature adoptable without giving up the archive's current hosting.
