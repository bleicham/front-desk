import test from "node:test";
import assert from "node:assert/strict";
import { buildModelContext, citedResults, parseAgentRequest } from "../scripts/agent-utils.mjs";

test("parses the structured AI issue created by the website", () => {
  const request = parseAgentRequest(
    "[Front Desk AI] How are model outputs formatted?",
    [
      "<!-- front-desk-ai -->",
      "### Question",
      "How are model outputs formatted?",
      "",
      "### Search scope",
      "docs",
    ].join("\n"),
  );
  assert.deepEqual(request, {
    isAiRequest: true,
    question: "How are model outputs formatted?",
    scope: "docs",
  });
});

test("invalid scopes safely fall back to auto", () => {
  const request = parseAgentRequest(
    "[Front Desk AI] Question",
    "### Question\nQuestion\n\n### Search scope\neverything-secret",
  );
  assert.equal(request.scope, "auto");
});

test("ordinary issues remain valid agent questions", () => {
  const request = parseAgentRequest("How do I start?", "Please point me to the guide.");
  assert.equal(request.isAiRequest, false);
  assert.equal(request.question, "How do I start?\n\nPlease point me to the guide.");
});

test("model context is capped and citations resolve to numbered results", () => {
  const results = Array.from({ length: 20 }, (_, index) => ({
    chunk: { source: `page-${index}.html`, text: `Passage ${index} `.repeat(20) },
  }));
  const built = buildModelContext(results, { maxChunks: 4, maxChars: 1000 });
  assert.equal(built.results.length, 4);
  assert.equal(built.results.reduce((sum, result) => sum + result.promptText.length, 0) <= 1000, true);
  assert.deepEqual(citedResults("Supported by [2] and [4]. Also [2].", built.results), [
    built.results[1],
    built.results[3],
  ]);
});
