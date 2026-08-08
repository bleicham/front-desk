# Front Desk — verified, cited, and free

This repository publishes a public GitHub Pages front desk that searches your
documents and official web sources without a paid AI API.

The accuracy rules are intentionally strict:

- Complete Hubverse directory questions use every row in the official table,
  not a limited set of search results.
- Clinical-code list questions scan every matching spreadsheet row.
- Ordinary questions use local embeddings plus exact-word ranking, then quote
  or format the best matching source passage.
- Weak matches return “I don't have a confident answer” instead of guessing.
- Every result shows a source link. Structured results also show the exact
  table location and source update date.

This can guarantee that an answer is supported by the indexed source. It
cannot guarantee that the source document itself is correct or current.

## What to upload to GitHub

Upload the complete contents of this folder to the root of your repository,
including the hidden `.github` folder. Keep your own files inside `knowledge/`.
Do not upload `site/index.json`; GitHub Actions generates it.

If you previously installed the GitHub Models version, make sure these files
are replaced by the copies in this package:

- `.github/workflows/agent.yml` — disables the retired issue agent
- `scripts/agent.mjs` — prevents accidental retired-API use
- `site/index.html`, `site/app.js`, and `site/style.css` — remove the obsolete
  AI button and paid API-key settings

The important new verified-source files are:

- `sources.yml`
- `scripts/hubverse-hubs.mjs`
- `scripts/build-index.mjs`
- `site/retrieval.js`
- `test/hubverse-hubs.test.mjs`

## Turn on the public page

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions**.
3. Open **Actions** and confirm that **Build index & deploy Front Desk** passes.
4. Use the Pages URL shown by the deploy job.

The workflow also refreshes external sources every Monday. Public-repository
GitHub-hosted Actions runners and GitHub Pages do not require a paid AI API.

## How “What hubs are available?” works

`sources.yml` marks the official Hubverse list as a required structured source:

```yaml
structured_sources:
  - type: hubverse-hub-directory
    url: https://hubverse.io/community/hubs.html
    citation: https://hubverse.io/community/hubs.html
    required: true
```

At build time, the indexer parses the published directory table and verifies
that both its hub count and organization count match Hubverse's own summary.
If either count differs, the deployment fails instead of publishing a partial
list. The previous successful Pages deployment remains available.

At question time, directory requests bypass the normal top-results limit and
return every matching record grouped by category. Questions such as these are
handled deterministically:

- `What hubs are available?`
- `Which active hubs are available?`
- `List the archival hubs.`
- `Which hubs have RSV?`

## Add your own documents

Put supported files in `knowledge/` and push the change. Supported formats
include Markdown, text, CSV, JSON, YAML, HTML, PDF, DOCX, XLS, and XLSX.

Spreadsheets are indexed row-by-row while repeating their sheet and column
names. This prevents a value from becoming detached from its headings.

For the best answers, write source documents with clear headings, one topic per
section, explicit names, and stable links. For factual directories or catalogs,
prefer a structured table over paragraphs.

## Add websites or repositories

Edit `sources.yml`. Website crawling is capped so Actions runs stay bounded:

```yaml
websites:
  - url: https://example.org/docs/
    title: Example documentation
    crawl: true
    sitemap: true
    maxPages: 40

repositories:
  - repo: example-org/example-repo
    include:
      - docs/
      - README.md
```

For a private source repository, create a fine-grained, read-only GitHub token
and store it as the Actions secret `REPOS_TOKEN`. Never place a token in source
code or expose it to the public Pages site.

## Accuracy tests

Every deployment runs:

```text
npm test
npm run build
npm run evaluate
```

Add real questions that failed to `eval/questions.json` so future changes must
pass those cases before deployment. The manual **Compare free embedding
models** workflow can compare MiniLM and BGE-small against the same evaluation
set; both run locally in GitHub Actions and require no inference API key.

## Why there is no public generative-AI button

GitHub Models was retired on July 30, 2026. A teacher's GitHub Education or
Copilot entitlement also cannot safely be shared with anonymous visitors to a
public page. This version therefore uses a free open embedding model for search
and deterministic/extractive answers for reliability and cost control.
