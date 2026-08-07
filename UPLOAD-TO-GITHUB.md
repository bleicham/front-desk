# Upload this accuracy upgrade to `bleicham/front-desk`

This bundle keeps the Front Desk free. Search runs with open-source embedding
models in GitHub Actions and the visitor's browser. No paid API key is required.

## What to upload

Extract `front-desk-accuracy-upgrade.zip`, then upload the **contents** of the
extracted folder to the root of your GitHub repository. Do not upload the ZIP
itself, and keep these paths exactly as shown:

- `.github/workflows/deploy.yml` — replace
- `.github/workflows/benchmark-models.yml` — add
- `eval/questions.json` — add
- `scripts/agent.mjs` — replace
- `scripts/build-index.mjs` — replace
- `scripts/crawl-utils.mjs` — add
- `scripts/evaluate.mjs` — add
- `site/app.js` — replace
- `site/index.html` — replace
- `site/retrieval.js` — add or replace
- `site/style.css` — replace
- `test/crawl-utils.test.mjs` — add
- `test/retrieval.test.mjs` — add or replace
- `package.json` — replace
- `sources.yml` — replace
- `README.md` — replace

Do not replace your `knowledge/` folder. Your Excel workbook remains where it is.

## Easiest GitHub upload

1. Open <https://github.com/bleicham/front-desk>.
2. Select **Add file → Upload files**.
3. Drag the extracted folder contents onto the upload page. Make sure GitHub
   shows the nested `.github`, `eval`, `scripts`, `site`, and `test` paths.
4. Commit the changes to `main`.
5. Open **Actions → Build index & deploy Front Desk** and watch the run. It now
   builds the index, runs the accuracy checks, and deploys only after the core
   checks pass.

The crawl now discovers sitemap pages and is capped at 60 pages for each
Hubverse source. The first build can therefore take longer than before.

## After deployment

Try these searches:

- `What is ICD-10 code J12.82?`
- `List all LOINC codes for HIV`
- `What are all codes for COVID-19?`
- Choose **Hubverse website**, then ask: `What is the Hubverse?`
- Choose **Hubverse documentation**, then ask: `How should model output data be formatted?`

For the free model comparison, open **Actions → Compare free embedding models →
Run workflow**. It evaluates MiniLM and BGE-small without changing the deployed
model. Download the two evaluation artifacts to compare the results.

