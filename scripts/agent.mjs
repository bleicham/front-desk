/**
 * Front Desk — issue agent
 *
 * Runs in GitHub Actions when someone opens an issue. It:
 *   1. Downloads the deployed search index from the GitHub Pages site
 *   2. Embeds the visitor's question locally (same model as the site)
 *   3. Retrieves the most relevant passages
 *   4. Asks a model on GitHub Models (free, uses the repo's own
 *      GITHUB_TOKEN — no API key or billing) to compose an answer
 *   5. Posts the answer as a comment on the issue, with sources
 *
 * If the model call fails (e.g. free-tier rate limit), it falls back to
 * posting the best matching passages so the visitor still gets help.
 */

import { env, pipeline } from "@xenova/transformers";

env.cacheDir = ".model-cache";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/name"
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_TITLE = process.env.ISSUE_TITLE || "";
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const AGENT_MODEL = process.env.AGENT_MODEL || "openai/gpt-4o-mini";
const TOP_K = 6;
const MIN_SCORE = 0.25;

// Where the deployed index lives. Default is the standard Pages URL for
// this repo; set PAGES_URL in the workflow if you use a custom domain.
const [owner, name] = REPO.split("/");
const PAGES_URL = (process.env.PAGES_URL || `https://${owner}.github.io/${name}`).replace(/\/$/, "");

/* ── Helpers ─────────────────────────────────────────────── */

async function githubApi(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function postComment(body) {
  await githubApi(`/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function sourceLink(index, chunk) {
  if (chunk.link) return chunk.link;
  if (!index.repo) return null;
  return `https://github.com/${index.repo}/blob/${index.branch || "main"}/${chunk.source}`;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const question = `${ISSUE_TITLE}\n\n${ISSUE_BODY}`.trim();
  if (!question) {
    console.log("Empty issue — nothing to answer.");
    return;
  }

  // 1. Load the deployed index.
  const res = await fetch(`${PAGES_URL}/index.json`, { cache: "no-cache" });
  if (!res.ok) {
    await postComment(
      "🛎️ Thanks for your question! The Front Desk index isn't deployed yet " +
      "(couldn't load it from the Pages site), so I can't look this up right now. " +
      "A maintainer will follow up."
    );
    throw new Error(`Couldn't fetch ${PAGES_URL}/index.json (HTTP ${res.status})`);
  }
  const index = await res.json();

  // 2–3. Embed the question and retrieve.
  console.log(`Embedding question with ${index.model}…`);
  const embed = await pipeline("feature-extraction", index.model, { quantized: true });
  const output = await embed(question.slice(0, 2000), { pooling: "mean", normalize: true });
  const query = Array.from(output.data);

  const results = index.chunks
    .map((chunk) => ({ chunk, score: dot(query, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .filter((r) => r.score >= MIN_SCORE);

  if (results.length === 0) {
    await postComment(
      "🛎️ Thanks for your question! I searched our reference material but couldn't " +
      "find anything relevant. A maintainer will take a look — or try rephrasing, " +
      "or ask on the [Front Desk site](" + PAGES_URL + ")."
    );
    return;
  }

  // Deduplicate sources for the footer.
  const seen = new Map();
  for (const r of results) if (!seen.has(r.chunk.source)) seen.set(r.chunk.source, r);
  const sourceList = [...seen.values()]
    .map((r) => {
      const url = sourceLink(index, r.chunk);
      return url ? `- [${r.chunk.title}](${url})` : `- ${r.chunk.title} (\`${r.chunk.source}\`)`;
    })
    .join("\n");

  // 4. Compose an answer with GitHub Models (free tier, GITHUB_TOKEN).
  const context = results
    .map((r, i) => `[${i + 1}] (${r.chunk.source})\n${r.chunk.text}`)
    .join("\n\n---\n\n");

  let answer = null;
  try {
    const modelRes = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content:
              "You are the front desk agent for this organization's repository. " +
              "Answer the visitor's question using ONLY the numbered reference passages. " +
              "Cite passages inline like [1]. If the passages don't fully answer it, say " +
              "what you did find and note that a maintainer can add more detail. " +
              "Be warm, concise, and professional. Format for a GitHub comment (Markdown).",
          },
          { role: "user", content: `Reference passages:\n\n${context}\n\nQuestion: ${question}` },
        ],
      }),
    });
    if (!modelRes.ok) throw new Error(`GitHub Models → ${modelRes.status}: ${await modelRes.text()}`);
    const data = await modelRes.json();
    answer = data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn(`Model call failed, falling back to passages: ${err.message}`);
  }

  // 5. Post the comment.
  const body = answer
    ? `🛎️ ${answer}\n\n---\n**Sources**\n${sourceList}\n\n<sub>Answered automatically by the Front Desk agent from this repo's reference material. A human can correct anything above.</sub>`
    : `🛎️ Thanks for your question! Here's the most relevant passage from our reference material:\n\n> ${results[0].chunk.text.slice(0, 900).replace(/\n/g, "\n> ")}\n\n**Sources**\n${sourceList}\n\n<sub>The Front Desk agent found these automatically; the answer-writing model was unavailable just now, so passages are shown directly.</sub>`;

  await postComment(body);
  console.log("Comment posted.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
