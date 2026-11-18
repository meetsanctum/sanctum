# Docs

The documentation site, published at <https://docs.meetsanctum.com>: Markdown
pages built by [Starlight](https://starlight.astro.build) into static files.

```sh
pnpm --filter @meetsanctum/docs dev     # http://localhost:5175
pnpm --filter @meetsanctum/docs build   # dist/, with every internal link checked
```

`pnpm dev` at the repository's root runs it too.

## Writing a page

Each page is a Markdown file in `src/content/docs`, and its path is its
address: `install/updating.md` is `/install/updating/`. A page starts with
its title, which Starlight shows as its heading, and a one-line description
for search results and link previews:

```md
---
title: Updating
description: Update Sanctum from the Mac app, rebuild the app to match, and the edge channel.
sidebar:
  order: 2
---

In the Mac app, Settings → System shows the version…
```

The page's own headings start at `##`. The sidebar lists each folder's pages
by their `sidebar.order`; a new folder gets its group in `astro.config.mjs`.

Link to another page by its address, with a heading's anchor where it helps:
`[Zigbee does not start](/install/troubleshooting/#zigbee-does-not-start)`.
The build fails on a link to a page or heading that doesn't exist.

## Images

A screenshot sits beside the page that shows it, and the page names it by a
relative path:

```md
![The Add devices sheet, with two lights that have joined](./add-devices.png)
```

The brand's files come from `@meetsanctum/brand`, as the welcome page's
picture of the Mac app does. Astro turns each image into WebP as it builds.

## Publishing

The site runs on [Railway](https://railway.com) as the `docs` service beside
the website's, described in
[`.railway/railway.ts`](../../.railway/railway.ts): Railway builds it from
`main` when a push changes what it is built from, and `pnpm start` serves
`dist` with [serve](https://github.com/vercel/serve) on the port Railway
gives it. [The website's README](../website/README.md#publishing) has how
that file is applied. `DOCS_URL` replaces the site's address for a copy
published somewhere else.

`pnpm dev` runs `astro dev` with `--ignore-lock`, which keeps it in the
foreground even when Astro detects an agent, so it stops with the rest of
the development stack.
