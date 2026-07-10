# castro

> [!NOTE]
> This project is work in progress. Expect breaking changes.

A static forum archive viewer built with [Astro](https://astro.build). Point it at a folder of JSON data and it generates a browsable, searchable archive of forums, threads, and member profiles.

🌈 [Example Forum](https://idleberg.github.io/castro/)

## Prerequisites

- [Node.js](https://nodejs.org) v24+
- [pnpm](https://pnpm.io)

If you use [mise](https://mise.jdx.dev), the included `mise.toml` handles both.

## Installation

Use this repository as a template, then install dependencies:

```sh
pnpm install
```

## Data

Place your forum data as JSON files in the `data/` directory:

> [!NOTE]
> The JSON schemas as not yet finalized, so lets skip over this section.

## Configuration

Edit `astro.config.mjs` to set your site title and optional meta tags:

```js
export default defineConfig({
	...githubPages(),
	...siteConfig({
		title: 'My Forum Archive',
		description: 'An archive of the old forum',
		keywords: ['forum', 'archive'],
	}),
	// ...
});
```

## Development

```sh
pnpm dev        # start dev server
pnpm build      # build static site + search index
pnpm preview    # preview the build locally
```

## Deployment

The included `githubPages()` helper auto-configures `site` and `base` when running in GitHub Actions. For [other platforms](https://docs.astro.build/en/guides/deploy/), set these in `astro.config.mjs` directly.

## License

This work is licensed under the [MIT License](LICENSE).
