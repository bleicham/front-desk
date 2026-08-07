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
transformers.js embeds their question → cosine similarity →
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

**Websites** are fetched page-by-page (list each URL you want; direct PDF
links work too) and re-fetched on every build. The workflow also runs on a
weekly schedule, so linked pages stay current even when nobody pushes.

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

## The issue agent (free AI answers on GitHub itself)

The repo also ships a small agent: when anyone **opens an issue**, a workflow
retrieves the most relevant passages from the same index and asks a model on
**GitHub Models** — GitHub's free inference API, authenticated with the repo's
own built-in `GITHUB_TOKEN` — to compose an answer, then posts it as a comment
with source links. No API key, no billing.

Nothing to configure: it works as soon as the repo is pushed and the Pages
site has deployed once (the agent reads the index from the live site). The
free tier is rate-limited to a modest number of requests per day — plenty for
a front desk; if a call is rate-limited, the agent posts the best matching
passages instead, so questions never go unanswered. You can swap the model
via the `AGENT_MODEL` env var in `.github/workflows/agent.yml`.

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
│   └── build-index.mjs   ← extraction, chunking, embedding
└── .github/workflows/
    └── deploy.yml        ← build + deploy on every push
```
