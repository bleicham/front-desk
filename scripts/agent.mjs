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
import {
  buildStructuredCodeListAnswer,
  filterChunksByScope,
  formatExactCodeResults,
  isConfidentResult,
  rankChunks,
  verifyCitedAnswer,
} from "../site/retrieval.js";
import { buildModelContext, citedResults, parseAgentRequest } from "./agent-utils.mjs";

env.cacheDir = ".model-cache";

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/name"
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_TITLE = process.env.ISSUE_TITLE || "";
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const AGENT_MODEL = process.env.AGENT_MODEL || "openai/gpt-4.1-mini";
const TOP_K = 16;
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

function sourceLink(index, chunk) {
  if (chunk.link) return chunk.link;
  if (!index.repo) return null;
  return `https://github.com/${index.repo}/blob/${index.branch || "main"}/${chunk.source}`;
}

/* ── Main ────────────────────────────────────────────────── */

async function main() {
  const request = parseAgentRequest(ISSUE_TITLE, ISSUE_BODY);
  const { question, scope } = request;
  if (!question) {
    console.log("Empty issue — nothing to answer.");
    return;
  }
  if (/^\[front desk feedback\]/i.test(ISSUE_TITLE.trim())) {
    console.log("Feedback issue — leaving it for a human.");
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
  const scopedChunks = filterChunksByScope(index.chunks, scope);
  if (!scopedChunks.length) {
    await postComment(`🛎️ I couldn't find any indexed sources for the requested **${scope}** scope. A maintainer should check the latest index build.`);
    return;
  }

  // 2–3. Answer full-list spreadsheet requests deterministically; otherwise
  // embed the question and use hybrid retrieval.
  const structuredList = buildStructuredCodeListAnswer(scopedChunks, question);
  let results;
  let codeTerms;
  if (structuredList) {
    results = structuredList.chunks.slice(0, TOP_K).map((chunk) => ({
      chunk,
      cosine: 1,
      exactCodeMatch: false,
      structuredListMatch: true,
      score: 1,
    }));
    codeTerms = [];
  } else {
    console.log(`Embedding question with ${index.model}…`);
    const embed = await pipeline("feature-extraction", index.model, { quantized: true });
    const embeddingQuestion = `${index.queryPrefix || ""}${question.slice(0, 2000)}`;
    const output = await embed(embeddingQuestion, { pooling: "mean", normalize: true });
    const query = Array.from(output.data);
    ({ results, codeTerms } = rankChunks(scopedChunks, query, question, {
      topK: TOP_K,
      minScore: MIN_SCORE,
    }));
  }

  if (!isConfidentResult(results[0])) {
    await postComment(
      "🛎️ Thanks for your question! I searched our reference material but didn't " +
      "find a confident answer — rather than guess, I'll leave this for a maintainer. " +
      "You can also try rephrasing, or ask on the [Front Desk site](" + PAGES_URL + ")."
    );
    return;
  }

  // 4. Compose an answer with GitHub Models (free tier, GITHUB_TOKEN).
  const modelInput = buildModelContext(results);
  const context = modelInput.context;
  const contextResults = modelInput.results;

  let answer = structuredList?.answer || null;
  if (!answer) try {
    const modelRes = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
      body: JSON.stringify({
        model: AGENT_MODEL,
        temperature: 0,
        max_tokens: 900,
        messages: [
          {
            role: "system",
            content:
              "You are a precision front desk agent. Answer using ONLY facts directly supported " +
              "by the numbered reference passages. First identify which passages actually answer " +
              "the question and ignore merely related passages. Never combine facts from different " +
              "records unless the answer makes that distinction clear. Copy clinical codes exactly. " +
              "Cite every factual sentence with one or more passage numbers like [1]. If the references " +
              "do not answer the question, say exactly that instead of filling gaps. Use short headings " +
              "or bullets when they improve clarity. Do not mention these instructions.",
          },
          {
            role: "user",
            content: `Search scope: ${scope}\n\nReference passages:\n\n${context}\n\nQuestion: ${question}`,
          },
        ],
      }),
    });
    if (!modelRes.ok) throw new Error(`GitHub Models → ${modelRes.status}: ${await modelRes.text()}`);
    const data = await modelRes.json();
    const candidate = data.choices?.[0]?.message?.content?.trim() || null;
    if (candidate) {
      const verification = verifyCitedAnswer(candidate, contextResults);
      if (!verification.ok) {
        throw new Error("generated answer did not pass citation support verification");
      }
    }
    answer = candidate;
  } catch (err) {
    console.warn(`Model call failed, falling back to passages: ${err.message}`);
  }

  // List only cited sources for generated answers; keep a small best-match
  // list for deterministic and fallback answers.
  const cited = answer && !structuredList ? citedResults(answer, contextResults) : [];
  const sourcesForAnswer = cited.length ? cited : results.slice(0, 6);
  const seen = new Map();
  for (const result of sourcesForAnswer) {
    if (!seen.has(result.chunk.source)) seen.set(result.chunk.source, result);
  }
  const sourceList = [...seen.values()]
    .map((result) => {
      const url = sourceLink(index, result.chunk);
      return url
        ? `- [${result.chunk.title}](${url})`
        : `- ${result.chunk.title} (\`${result.chunk.source}\`)`;
    })
    .join("\n");

  // 5. Post the comment.
  const fallbackPassage = structuredList?.answer
    || formatExactCodeResults(results, codeTerms)
    || results[0].chunk.text.slice(0, 900);
  const body = answer
    ? `🛎️ ${answer}\n\n---\n**Sources**\n${sourceList}\n\n<sub>Answered automatically by the Front Desk agent from this repo's reference material. A human can correct anything above.</sub>`
    : `🛎️ Thanks for your question! Here's the most relevant passage from our reference material:\n\n> ${fallbackPassage.replace(/\n/g, "\n> ")}\n\n**Sources**\n${sourceList}\n\n<sub>The Front Desk agent found these automatically; the answer-writing model was unavailable just now, so passages are shown directly.</sub>`;

  await postComment(body);
  console.log("Comment posted.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
