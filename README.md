# 🛎️ Front Desk

A free, self-updating "front desk" for your GitHub organization. Drop files
into the `knowledge/` folder, and visitors get a polished GitHub Pages site
where they can ask questions and receive answers sourced from those files —
with links back to the originals.

**Zero servers. Zero API keys required. $0/month.** Everything runs on
GitHub Actions (indexing) and in the visitor's browser (search).

## How it works

```
knowledge/*.md, *.pdf, *.docx, …          (you drop files here)
        │
        ▼  on every push to main
GitHub Actions ── extracts text, chunks it, embeds each chunk
        │          with all-MiniLM-L6-v2 (runs locally in the Action)
        ▼
site/index.json ── deployed to GitHub Pages with the front end
        │
        ▼  in the visitor's browser
transformers.js embeds their question → BM25 + semantic rank fusion →
best passages shown, linked to the source files
```

This is retrieval-augmented search that's genuinely free: the embedding model
runs inside the Action runner at build time and inside the visitor's browser
at query time. Optionally, a visitor can add their own Anthropic API key in
the site's settings to have Claude compose full written answers from the
retrieved passages (the key never leaves their browser except to Anthropic).

## Setup (about 3 minutes)

1. **Create a repo** in your org (e.g. `your-org/front-desk`) and push these
   files to the `main` branch. The repo must be **public** for free GitHub
   Pages, unless your org has GitHub Enterprise.

2. **Enable Pages via Actions:** in the repo, go to
   **Settings → Pages → Build and deployment → Source** and choose
   **GitHub Actions**.

3. **Run the workflow:** it triggers automatically on push. (If you enabled
   Pages *after* pushing, go to **Actions → Build index & deploy Front Desk →
   Run workflow**.) The first run takes a few minutes while the embedding
   model downloads; later runs use the cache and are fast.

4. **Visit your site** at `https://your-org.github.io/front-desk/`.

5. **Make it yours:** edit the `window.FRONT_DESK` block at the top of
   `site/index.html` — org name, tagline, and the suggested questions shown
   as chips.

## Daily use

Drop files into `knowledge/` (subfolders are fine) and push — or just use
GitHub's web UI: **Add file → Upload files** into the `knowledge` folder.
The site rebuilds and redeploys itself in a couple of minutes.

Supported formats: `.md` `.txt` `.pdf` `.docx` `.xlsx` `.xls` `.html` `.csv`
`.tsv` `.json` `.yml` `.yaml` `.rst` `.org` `.log` — files over 10 MB are
skipped. Excel workbooks are indexed sheet by sheet, so code lists and
reference tables are searchable row by row.

## Websites and other repos as sources

Beyond dropping files into `knowledge/`, you can pull in external material by
editing `sources.yml` at the repo root:

```yaml
websites:
  - https://example.com/handbook
  - url: https://example.com/policies/travel
    title: Travel Policy

repositories:
  - my-org/engineering-handbook
  - repo: my-org/api-service
    include:
      - docs/
      - README.md
```

**Websites** are fetched page-by-page (direct PDF links work too). Set
`crawl: true` to discover same-site pages through sitemaps and links, with a
`maxPages` cap so builds stay predictable. Sources are re-fetched on every
build and on the weekly refresh.

## Accuracy checks

Every deployment now runs `npm run evaluate` before publishing. The evaluation
set in `eval/questions.json` checks exact ICD-10/LOINC lookups, complete code
lists, multi-system results, and website/documentation source scoping. Add real
questions and expected terms to that file whenever you find a miss; this turns
feedback into a regression test.

The search interface also includes a **Search in** selector. Leave it on Auto
for normal use, or choose Clinical codes, Hubverse website, or Hubverse
documentation when a question should use only one source family.

To compare the current MiniLM embeddings with the free BGE-small model, open
**Actions → Compare free embedding models → Run workflow**. The workflow builds
and evaluates both models without changing the deployed production model, then
uploads a JSON result for each. Only switch the production model after it wins
on your own questions.

**Repositories** are shallow-cloned at build time and every supported doc
file in them is indexed (use `include`/`exclude` path prefixes to keep big
repos focused). Public repos need nothing; for private repos in your org,
create a fine-grained personal access token with read-only Contents access to
those repos and save it as an Actions secret named `REPOS_TOKEN`
(**Settings → Secrets and variables → Actions → New repository secret**).

Source cards on the site link to the live web page or the file in its home
repo, so answers always point back to the original.

## Optional: full written answers with Claude

Out of the box the Front Desk shows the best matching passages (extractive
answers). For composed, conversational answers, a visitor can click
**Answer settings** in the footer and paste an Anthropic API key. The key is
stored only in their own browser's localStorage and requests go directly from
their browser to Anthropic — there's no server in the middle. Cost with the
default `claude-haiku-4-5` model is roughly a tenth of a cent per question.
Skip this optional setting to keep the Front Desk at $0; the GitHub AI flow
below does not use an Anthropic key.

## The issue agent (free AI answers on GitHub itself)

The site includes an **Ask AI on GitHub** button. It opens a prefilled issue;
after the visitor submits it, a workflow retrieves up to 16 strong candidate
passages and asks **GPT-4.1-mini through GitHub Models** to compose a concise
answer with citations. The agent verifies that generated statements are
supported by their cited passages before posting the answer as an issue
comment. The repository's built-in `GITHUB_TOKEN` stays inside GitHub Actions
and is never exposed to the browser.

Nothing to configure: it works as soon as the repo is pushed and the Pages
site has deployed once. GitHub Models' included usage is rate-limited and
intended for modest traffic. Keep paid Models usage disabled to enforce a $0
ceiling. If the model is unavailable or rate-limited, the agent posts the
strongest retrieved passage instead. You can swap the model through
`AGENT_MODEL` in `.github/workflows/agent.yml`.

To make the desk visible, add an issue template or a README badge inviting
people to "Open an issue to ask the Front Desk."

## Notes and limits

- **Public repo = public knowledge.** Anyone can read a public repo and its
  Pages site. Don't put confidential material in `knowledge/` unless your org
  has Enterprise (which allows private Pages with access control).
- **Index size.** Each passage adds ~4 KB to `index.json`. A few hundred
  pages of documents is comfortable; thousands of pages will make the first
  page load heavier (the JSON is gzip-compressed in transit, which helps a lot).
- **First visit download.** The visitor's browser fetches the ~25 MB search
  model once, then caches it.
- **Tuning.** Chunk size, overlap, and file-size limits live at the top of
  `scripts/build-index.mjs`; result count and match threshold at the top of
  `site/app.js`.

## Repo layout

```
├── knowledge/            ← drop your files here
├── site/                 ← the GitHub Pages front end
│   ├── index.html        ← branding config lives at the top
│   ├── style.css
│   ├── app.js
│   └── index.json        ← generated by the workflow (not committed)
├── scripts/
│   ├── build-index.mjs   ← extraction, crawling, chunking, embedding
│   ├── crawl-utils.mjs   ← URL, link, and sitemap discovery helpers
│   ├── agent-utils.mjs   ← safe issue parsing and bounded AI context
│   └── evaluate.mjs      ← repeatable retrieval accuracy checks
├── eval/
│   └── questions.json    ← expected retrieval behavior
└── .github/workflows/
    ├── deploy.yml        ← build, evaluate, and deploy on every push
    └── benchmark-models.yml ← manual MiniLM/BGE comparison
```
