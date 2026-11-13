# Website

The landing page and its waitlist: a Next.js site with the page, the install
instructions agents read (`public/install.md`), and the waitlist's routes and
its page for leaving.

```sh
pnpm --filter @meetsanctum/website dev     # http://localhost:5174
pnpm --filter @meetsanctum/website test
```

`pnpm dev` at the repository's root runs it too.

## The waitlist

The waitlist is kept with [Resend](https://resend.com): joining
(`POST /api/waitlist`) makes the address one of its contacts and sends it one
confirmation (`src/waitlist/email.ts`). An address already there is left as
it is and gets no second email, and the form hears the same answer either
way. While developing, <http://localhost:5174/emails/waitlist> shows the
confirmation as a page.

The confirmation's Unsubscribe opens `/unsubscribe/<contact>`, which asks
once and then removes the contact from Resend. Its `List-Unsubscribe` headers
name `/api/unsubscribe/<contact>`, where a mail app's own Unsubscribe posts
to do the same in one click.

Resend needs a verified domain to send from, and an API key with full access,
since a key that can only send cannot keep contacts.

## Settings

[`.env.example`](.env.example) lists what the site reads. Without
`RESEND_API_KEY` and `WAITLIST_FROM` the page works and the form says the
waitlist isn't set up.

[dotenvx](https://dotenvx.com) keeps the values. It encrypts each as it writes
it and puts the key that reads them in `.env.keys`, which git ignores:

```sh
cd apps/website
pnpm exec dotenvx set RESEND_API_KEY <key>
pnpm exec dotenvx set WAITLIST_FROM "Sanctum <hello@example.com>"
```

Those go to `.env`, which `pnpm dev` reads and git ignores. With
`-f .env.production` they go to the published site's file, the one env file
the repository holds: only encrypted, which `pnpm test` checks.

## Publishing

The site runs on [Railway](https://railway.com) as one service, which Railway
builds from this repository and starts with `pnpm start`.
[`.railway/railway.ts`](../../.railway/railway.ts) describes it: where the
source is, the commands, which changes deploy, the domain and the variables.
Railway reads that file only when the CLI applies it, from a checkout linked
to the project (`railway link`):

```sh
railway config plan    # what applying would change, changing nothing
railway config apply   # change it, after a look at the same plan
```

The file is the whole project: a service or variable on Railway that it
doesn't name is one the plan removes.

`pnpm start` runs the server through dotenvx with `.env.production`, and what
Railway sets wins over the file. So Railway holds one secret,
`DOTENV_PRIVATE_KEY_PRODUCTION`, the key from `.env.keys`, set there by hand;
the file keeps it across applies. With `.env.production` in the repository
and the key missing, the server stops as it starts. `SITE_URL`, for a copy
published at another address than the one in `src/site.ts`, is a variable in
plain text, written in `.railway/railway.ts` like the rest: the page takes it
in as the site is built.
