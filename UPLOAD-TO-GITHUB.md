# Upload these files to `bleicham/front-desk`

Upload the files with the same paths shown below:

- `package.json` — replace the existing root file
- `sources.yml` — replace the existing file; enables bounded crawling of the Hubverse website and documentation
- `scripts/build-index.mjs` — replace the existing file
- `scripts/agent.mjs` — replace the existing file
- `site/app.js` — replace the existing file
- `site/retrieval.js` — add this new file
- `test/retrieval.test.mjs` — add this new file

## GitHub website

1. Download and extract `front-desk-github-files.zip`. Do not upload the ZIP itself.
2. Open https://github.com/bleicham/front-desk and select **Add file → Upload files**.
3. Drag the extracted `package.json`, `scripts`, `site`, and `test` items onto the upload page. Keep the folder structure intact.
4. Commit the files to the `main` branch.
5. Open the repository's **Actions** tab. The existing **Build index & deploy Front Desk** workflow should rebuild and deploy the site automatically.

The first rebuild can take longer because it now indexes up to 40 pages from
`hubverse.io` and 40 pages from `docs.hubverse.io`. This remains free and uses
the existing GitHub Actions workflow.

After deployment, try questions such as:

- `List all LOINC codes for HIV`
- `What are all codes for COVID-19?`
- `According to the Hubverse website, what are model tasks?`
- `What does the Hubverse documentation say about model output?`

No workbook, workflow, API key, or paid service needs to be added.
