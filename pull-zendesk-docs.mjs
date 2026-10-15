#!/usr/bin/env node
// Pull Zendesk Help Center (Guide) articles into markdown files for use as
// local agent context (RAG). Files are grouped on disk to mirror Zendesk's
// category/section hierarchy and named after the article title:
//
//   <out>/<category-slug>/<section-slug>/<title-slug>.md
//
// An INDEX.md (category -> section -> article table of contents) is generated
// at the output root so an agent can navigate the corpus quickly.
//
// Usage:
//   node pull-zendesk-docs.mjs [--out DIR] [--locale en-us] [--full]
//
// Incremental by default: tracks the newest article `updated_at` seen in a
// cursor file (.zendesk-sync.json inside the output dir) and only (re)writes
// articles changed since the last run. Pass --full to ignore the cursor and
// refetch everything.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import TurndownService from 'turndown';

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { out: 'zendesk-docs', locale: 'en-us', full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--locale') opts.locale = argv[++i];
    else if (a === '--full') opts.full = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      opts.help = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`Pull Zendesk Guide articles to markdown.

Usage: node pull-zendesk-docs.mjs [options]

Options:
  --out DIR       Output directory (default: zendesk-docs)
  --locale LOC    Help Center locale (default: en-us)
  --full          Ignore the sync cursor and refetch all articles
  -h, --help      Show this help

Env (required): ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN`);
}

// ---- zendesk ----------------------------------------------------------------
function env() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN;
  const email = process.env.ZENDESK_EMAIL;
  const token = process.env.ZENDESK_API_TOKEN;
  const missing = [
    ['ZENDESK_SUBDOMAIN', subdomain],
    ['ZENDESK_EMAIL', email],
    ['ZENDESK_API_TOKEN', token],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }
  return { subdomain, email, token };
}

function authHeader({ email, token }) {
  // Zendesk basic auth: "{email}/token:{api_token}" base64-encoded.
  const raw = `${email}/token:${token}`;
  return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
}

async function getJson(url, headers) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`zendesk api error: ${resp.status} ${body.slice(0, 200)}`);
  }
  return resp.json();
}

function firstPageUrl(base, locale, perPage = 100) {
  return `${base}/api/v2/help_center/${locale}/articles.json?per_page=${perPage}&sort_by=updated_at&sort_order=asc`;
}

// Fetch every item from a paginated Help Center list endpoint (categories,
// sections, ...). Returns a flat array across all pages.
async function getAllPaged(firstUrl, headers, key) {
  const items = [];
  let url = firstUrl;
  while (url) {
    const payload = await getJson(url, headers);
    for (const item of payload[key] ?? []) items.push(item);
    url = payload.next_page || null;
  }
  return items;
}

// Build a lookup from section_id -> { category, section } display names and
// slugged directory paths, by fetching the Help Center taxonomy.
async function fetchTaxonomy(base, locale, headers) {
  const [categories, sections] = await Promise.all([
    getAllPaged(
      `${base}/api/v2/help_center/${locale}/categories.json?per_page=100`,
      headers,
      'categories',
    ),
    getAllPaged(
      `${base}/api/v2/help_center/${locale}/sections.json?per_page=100`,
      headers,
      'sections',
    ),
  ]);

  const categoryById = new Map();
  for (const c of categories) {
    categoryById.set(c.id, { name: c.name, slug: slugify(c.name) });
  }

  const sectionById = new Map();
  for (const s of sections) {
    const cat = categoryById.get(s.category_id) || {
      name: 'Uncategorized',
      slug: 'uncategorized',
    };
    sectionById.set(s.id, {
      categoryName: cat.name,
      categorySlug: cat.slug,
      sectionName: s.name,
      sectionSlug: slugify(s.name),
    });
  }

  return { sectionById };
}

// Resolve an article's section_id to its directory path + display names.
// Falls back to an "uncategorized" bucket when the section is unknown.
function groupFor(taxonomy, sectionId) {
  const hit = taxonomy.sectionById.get(sectionId);
  if (hit) {
    return {
      categoryName: hit.categoryName,
      sectionName: hit.sectionName,
      dir: path.join(hit.categorySlug, hit.sectionSlug),
    };
  }
  return {
    categoryName: 'Uncategorized',
    sectionName: 'Uncategorized',
    dir: path.join('uncategorized', 'uncategorized'),
  };
}

// ---- html -> markdown -------------------------------------------------------
// Real parser (turndown) rather than regex. Configured for GitHub-flavored
// output: ATX headings, fenced code blocks, dash bullets.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

// Preserve code block language hints when Zendesk emits <pre><code class="language-x">.
turndown.addRule('fencedCodeWithLang', {
  filter: (node) =>
    node.nodeName === 'PRE' &&
    node.firstChild &&
    node.firstChild.nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = node.firstChild;
    const className = code.getAttribute('class') || '';
    const lang = (className.match(/language-(\S+)/) || [])[1] || '';
    const text = code.textContent.replace(/\n$/, '');
    return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
  },
});

function htmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- output -----------------------------------------------------------------
function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'article';
}

function renderArticle(article, locale, group) {
  const fm = [
    '---',
    `title: ${JSON.stringify(String(article.title ?? ''))}`,
    `article_id: ${article.id}`,
    `locale: ${locale}`,
    `category: ${JSON.stringify(String(group.categoryName ?? ''))}`,
    `section: ${JSON.stringify(String(group.sectionName ?? ''))}`,
    `section_id: ${article.section_id ?? ''}`,
    `url: ${article.html_url ?? ''}`,
    `updated_at: ${article.updated_at ?? ''}`,
    '---',
    '',
  ].join('\n');

  const body = htmlToMarkdown(article.body);
  return (
    fm +
    `# ${article.title}\n\n` +
    `- Category: ${group.categoryName}\n` +
    `- Section: ${group.sectionName}\n` +
    `- Article ID: \`${article.id}\`\n` +
    `- URL: ${article.html_url}\n` +
    `- Updated At: \`${article.updated_at}\`\n\n` +
    `## Body\n\n` +
    (body || '_No body content extracted._') +
    '\n'
  );
}

async function loadCursor(dir) {
  const file = path.join(dir, '.zendesk-sync.json');
  if (!existsSync(file)) return { file, lastUpdatedAt: null };
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return { file, lastUpdatedAt: data.lastUpdatedAt ?? null };
  } catch {
    return { file, lastUpdatedAt: null };
  }
}

// Pick a stable, title-based filename for an article inside its section dir.
// The clean `title.md` is reused across runs for the same article so
// incremental syncs overwrite in place; a short id suffix is only added to
// disambiguate different articles that would otherwise collide.
function resolveArticleFilename(article, absDir, taken) {
  const slug = slugify(article.title);
  const plain = `${slug}.md`;
  const idSuffixed = `${slug}-${article.id}.md`;
  const id = String(article.id);

  const ownedBy = (candidate) => {
    const abs = path.join(absDir, candidate);
    if (!existsSync(abs)) return null; // no file -> free to take
    const fm = parseFrontmatter(readFileSync(abs, 'utf8'));
    return String(fm.article_id ?? '') === id; // true=ours, false=someone else's
  };

  // Prefer whichever existing file already belongs to this article (overwrite
  // in place), checking the clean name first.
  for (const candidate of [plain, idSuffixed]) {
    if (!taken.has(candidate) && ownedBy(candidate) === true) return candidate;
  }

  // Clean name is free (no file, or ours already handled above)?
  if (!taken.has(plain) && ownedBy(plain) === null) return plain;

  // Otherwise a different article holds the clean name: disambiguate by id.
  return idSuffixed;
}

// Parse the minimal frontmatter we wrote (title, category, section, url).
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep raw */
      }
    }
    out[kv[1]] = v;
  }
  return out;
}

// Recursively collect every article .md (ignoring INDEX.md) under the output
// dir and read its frontmatter so the index reflects ALL articles on disk,
// not just those (re)written this run.
async function collectArticles(outDir, absDir = outDir, rel = '') {
  const rows = [];
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(absDir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      rows.push(...(await collectArticles(outDir, abs, relPath)));
    } else if (entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      const fm = parseFrontmatter(await readFile(abs, 'utf8'));
      rows.push({
        relPath: relPath.split(path.sep).join('/'),
        title: fm.title || entry.name.replace(/\.md$/, ''),
        category: fm.category || 'Uncategorized',
        section: fm.section || 'Uncategorized',
        url: fm.url || '',
      });
    }
  }
  return rows;
}

// Build INDEX.md: a category -> section -> article table of contents linking
// to every local file, so an agent can navigate the corpus quickly.
async function writeIndex(outDir, locale) {
  const rows = await collectArticles(outDir);
  rows.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.section.localeCompare(b.section) ||
      a.title.localeCompare(b.title),
  );

  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, new Map());
    const sections = byCategory.get(r.category);
    if (!sections.has(r.section)) sections.set(r.section, []);
    sections.get(r.section).push(r);
  }

  const lines = [
    '# Zendesk Docs Index',
    '',
    `Locale: \`${locale}\` · ${rows.length} article(s) · generated ${new Date().toISOString()}`,
    '',
    'Files are grouped by Zendesk category / section and named after their',
    'article title. Browse below or open a file directly.',
    '',
  ];

  for (const [category, sections] of byCategory) {
    lines.push(`## ${category}`, '');
    for (const [section, articles] of sections) {
      lines.push(`### ${section}`, '');
      for (const a of articles) {
        const link = encodeURI(a.relPath);
        lines.push(`- [${a.title}](${link})`);
      }
      lines.push('');
    }
  }

  await writeFile(
    path.join(outDir, 'INDEX.md'),
    lines.join('\n') + '\n',
    'utf8',
  );
  return rows.length;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const creds = env();
  const base = `https://${creds.subdomain}.zendesk.com`;
  const headers = {
    Authorization: authHeader(creds),
    'Content-Type': 'application/json',
  };

  const outDir = path.resolve(opts.out);
  await mkdir(outDir, { recursive: true });

  const { file: cursorFile, lastUpdatedAt } = opts.full
    ? { file: path.join(outDir, '.zendesk-sync.json'), lastUpdatedAt: null }
    : await loadCursor(outDir);
  const cursorTime = lastUpdatedAt ? Date.parse(lastUpdatedAt) : null;

  if (cursorTime) {
    console.log(
      `Incremental sync since ${lastUpdatedAt} (locale ${opts.locale})`,
    );
  } else {
    console.log(`Full sync (locale ${opts.locale})`);
  }

  console.log('Fetching category/section taxonomy...');
  const taxonomy = await fetchTaxonomy(base, opts.locale, headers);

  let pageUrl = firstPageUrl(base, opts.locale);
  let written = 0;
  let skipped = 0;
  let maxUpdated = cursorTime;
  let maxUpdatedIso = lastUpdatedAt;
  // Track names claimed this run per directory, to disambiguate collisions.
  const takenByDir = new Map();

  while (pageUrl) {
    const payload = await getJson(pageUrl, headers);
    for (const article of payload.articles ?? []) {
      const updated = Date.parse(article.updated_at);
      if (cursorTime && updated <= cursorTime) {
        skipped++;
        continue;
      }
      const group = groupFor(taxonomy, article.section_id);
      const absDir = path.join(outDir, group.dir);
      await mkdir(absDir, { recursive: true });

      if (!takenByDir.has(absDir)) takenByDir.set(absDir, new Set());
      const taken = takenByDir.get(absDir);
      const filename = resolveArticleFilename(article, absDir, taken);
      taken.add(filename);

      await writeFile(
        path.join(absDir, filename),
        renderArticle(article, opts.locale, group),
        'utf8',
      );
      written++;
      if (maxUpdated == null || updated > maxUpdated) {
        maxUpdated = updated;
        maxUpdatedIso = article.updated_at;
      }
    }
    pageUrl = payload.next_page || null;
  }

  if (maxUpdatedIso) {
    await writeFile(
      cursorFile,
      JSON.stringify({ lastUpdatedAt: maxUpdatedIso }, null, 2) + '\n',
      'utf8',
    );
  }

  const indexed = await writeIndex(outDir, opts.locale);

  console.log(
    `Done. Wrote ${written} article(s), skipped ${skipped} unchanged. ` +
      `INDEX.md lists ${indexed}. Output: ${outDir}`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
