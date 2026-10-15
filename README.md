# zendesk-docs-puller

Pull your Zendesk Help Center (Guide) articles into markdown files — one file
per article, grouped on disk to mirror Zendesk's category/section hierarchy and
named after the article title so a local AI agent can grep/read them as
context (a simple RAG corpus). A top-level `INDEX.md` table of contents is
generated to make the corpus easy to navigate.

## Requirements

- Node.js 18+ (uses the built-in global `fetch`)
- A Zendesk API token

## Install

```sh
npm install
```

## Configure

Provide the needed env vars. Either set them in your shell, or
copy `.env.example` to `.env` and fill it in (the script auto-loads `.env`):

```sh
cp .env.example .env
```

```ini
# .env
ZENDESK_SUBDOMAIN=yoursubdomain   # the "foo" in foo.zendesk.com
ZENDESK_EMAIL=you@company.com
ZENDESK_API_TOKEN=xxxxxxxx
```

Or export them directly:

```sh
# PowerShell
$env:ZENDESK_SUBDOMAIN = "yoursubdomain"
$env:ZENDESK_EMAIL     = "you@company.com"
$env:ZENDESK_API_TOKEN = "xxxxxxxx"

# bash/zsh
export ZENDESK_SUBDOMAIN=yoursubdomain
export ZENDESK_EMAIL=you@company.com
export ZENDESK_API_TOKEN=xxxxxxxx
```

Shell-set vars take precedence over `.env`. Auth uses Zendesk's
`{email}/token:{api_token}` basic auth scheme.

## Usage

```sh
# incremental pull into ./zendesk-docs (default)
npm run pull

# ignore the sync cursor and refetch everything
npm run pull:full

# or call the script directly with options
node pull-zendesk-docs.mjs --out docs --locale en-us
```

### Options

| Flag           | Default        | Description                                |
| -------------- | -------------- | ------------------------------------------ |
| `--out DIR`    | `zendesk-docs` | Output directory                           |
| `--locale LOC` | `en-us`        | Help Center locale                         |
| `--full`       | off            | Ignore the cursor and refetch all articles |
| `-h`, `--help` |                | Show help                                  |

## How it works

- Fetches the Help Center taxonomy from
  `GET /api/v2/help_center/{locale}/categories.json` and `.../sections.json` to
  resolve each article's `section_id` into its category/section names.
- Lists articles from `GET /api/v2/help_center/{locale}/articles.json`, sorted by
  `updated_at` ascending, following `next_page` pagination.
- Writes each article to
  `<out>/<category-slug>/<section-slug>/<title-slug>.md`, with YAML frontmatter
  (title, id, locale, category, section, section_id, url, updated_at) plus the
  converted markdown body. Articles whose section can't be resolved land in
  `uncategorized/uncategorized/`.
  - The title-based filename stays stable across runs so incremental syncs
    overwrite in place. If two different articles in the same section share a
    title, the later one gets a short `-{id}` suffix to avoid a collision.
- Generates `<out>/INDEX.md`: a category → section → article table of contents
  linking to every local file. It is rebuilt each run by scanning the output
  directory, so it stays complete even during incremental syncs.
- **Incremental sync:** records the newest `updated_at` seen in
  `<out>/.zendesk-sync.json` and, on the next run, skips anything not changed
  since. Use `--full` to force a complete refresh.

## Point your agent at it

Give your agent the output directory (e.g. `./zendesk-docs`) as a readable
context folder. Start it at `INDEX.md` to see the full category/section layout,
then read individual files — each is self-contained markdown it can search and
cite.
