# Upload this version

1. Extract the ZIP.
2. Upload **everything inside** `front-desk-verified-sources` to the root of
   your GitHub repository. Include `.github`.
3. Allow GitHub to replace files with the same names.
4. Do not upload `site/index.json`; the workflow creates it.
5. In **Settings → Pages**, choose **GitHub Actions**.
6. Open **Actions → Build index & deploy Front Desk** and confirm it passes.

This package replaces the earlier GitHub Models version. In particular, be
sure `.github/workflows/agent.yml` is replaced so the retired issue agent is
disabled.

Your existing documents belong in `knowledge/`. The included copies are the
documents that were already present in the working repository.
