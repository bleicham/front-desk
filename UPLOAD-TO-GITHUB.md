# Upload the GitHub AI upgrade

This bundle includes the accuracy improvements plus a secure, free-tier
GitHub Models answer flow. No GitHub token is placed in the webpage.

## Upload

1. Extract `front-desk-github-ai-upgrade.zip`.
2. Open <https://github.com/bleicham/front-desk>.
3. Choose **Add file → Upload files**.
4. Upload the **contents of the extracted folder**, preserving the `.github`,
   `eval`, `scripts`, `site`, and `test` directories.
5. Commit the changes to `main`.

Do not upload the ZIP itself. Do not delete or replace your `knowledge/`
folder—the existing workbook stays there.

## Files in this upgrade

- `.github/workflows/agent.yml` — GPT-4.1-mini issue agent
- `.github/workflows/deploy.yml` — build, evaluate, and deploy
- `.github/workflows/benchmark-models.yml` — optional embedding comparison
- `scripts/agent.mjs` — scoped retrieval, GitHub Models call, verified answer
- `scripts/agent-utils.mjs` — safe issue parsing and prompt-size limits
- `scripts/build-index.mjs`, `scripts/crawl-utils.mjs`, `scripts/evaluate.mjs`
- `site/index.html`, `site/style.css`, `site/app.js`, `site/retrieval.js`
- `test/*.test.mjs`, `eval/questions.json`
- `package.json`, `sources.yml`, `README.md`

## Enable and test

1. Open **Settings → Actions → General** and ensure Actions are allowed.
2. Open **Actions → Build index & deploy Front Desk** and wait for deployment.
3. Visit the Pages site, type a question, select its source, and click
   **Ask AI on GitHub**.
4. GitHub opens a prefilled issue. Select **Submit new issue**.
5. Watch **Actions → Front Desk agent (answers new issues)**. GPT-4.1-mini
   should post a cited answer as an issue comment.

The visitor must be signed in to GitHub to submit the issue. GitHub Models is
rate-limited. Keep paid Models usage disabled to maintain a $0 ceiling; when
the model is unavailable, the workflow posts the best source passage instead.

If the workflow reports that Models access is disabled, enable GitHub Models
for the repository or account in GitHub's Models settings, then open a new AI
question issue.

