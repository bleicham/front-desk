const VALID_SCOPES = new Set(["auto", "codes", "website", "docs"]);

/** Parse either a normal issue or the structured issue created by the site. */
export function parseAgentRequest(title, body) {
  const issueTitle = String(title || "").trim();
  const issueBody = String(body || "").trim();
  const isAiRequest = /^\[front desk ai\]/i.test(issueTitle) || /<!--\s*front-desk-ai\s*-->/i.test(issueBody);
  if (!isAiRequest) {
    return {
      isAiRequest: false,
      question: `${issueTitle}\n\n${issueBody}`.trim(),
      scope: "auto",
    };
  }

  const questionMatch = issueBody.match(/###\s*Question\s*\n([\s\S]*?)(?=\n###\s*Search scope|$)/i);
  const scopeMatch = issueBody.match(/###\s*Search scope\s*\n([^\n]+)/i);
  const titleQuestion = issueTitle.replace(/^\[front desk ai\]\s*/i, "").trim();
  const requestedScope = String(scopeMatch?.[1] || "auto").trim().toLowerCase();
  return {
    isAiRequest: true,
    question: String(questionMatch?.[1] || titleQuestion).trim(),
    scope: VALID_SCOPES.has(requestedScope) ? requestedScope : "auto",
  };
}

/** Keep the model prompt inside the free tier while offering a wider candidate pool. */
export function buildModelContext(results, options = {}) {
  const maxChunks = options.maxChunks || 16;
  const maxChars = options.maxChars || 24000;
  const selected = [];
  let usedChars = 0;

  for (const result of results.slice(0, maxChunks)) {
    const text = String(result.chunk.text || "").trim();
    if (!text) continue;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    if (remaining < 200 && selected.length) break;
    const clipped = text.slice(0, remaining);
    selected.push({ ...result, promptText: clipped });
    usedChars += clipped.length;
  }

  const context = selected
    .map((result, index) => `[${index + 1}] (${result.chunk.source})\n${result.promptText}`)
    .join("\n\n---\n\n");
  return { context, results: selected };
}

export function citedResults(answer, results) {
  const indexes = [...String(answer || "").matchAll(/\[(\d+)\]/g)]
    .map((match) => Number(match[1]) - 1)
    .filter((index) => index >= 0 && index < results.length);
  return [...new Set(indexes)].map((index) => results[index]);
}
