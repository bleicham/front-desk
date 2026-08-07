import { appendFile, readFile, writeFile } from "node:fs/promises";
import { env, pipeline } from "@xenova/transformers";
import {
  buildStructuredCodeListAnswer,
  extractCodeTerms,
  filterChunksByScope,
  formatExactCodeResults,
  isConfidentResult,
  rankChunks,
} from "../site/retrieval.js";

env.cacheDir = ".model-cache";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function includesIgnoreCase(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function sourceText(result) {
  return `${result.chunk.source || ""} ${result.chunk.link || ""}`;
}

const indexPath = argument("--index", "site/index.json");
const casesPath = argument("--cases", "eval/questions.json");
const outputPath = argument("--output", "evaluation-results.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
const cases = JSON.parse(await readFile(casesPath, "utf8"));
let embedder = null;

async function embedQuestion(question) {
  embedder ||= await pipeline("feature-extraction", index.model, { quantized: true });
  const output = await embedder(`${index.queryPrefix || ""}${question}`, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}

async function runCase(testCase) {
  const chunks = filterChunksByScope(index.chunks, testCase.scope || "auto");
  const checks = [];
  let results = [];
  let answer = "";
  let uniqueCodeCount = null;

  if (!chunks.length) {
    checks.push({ check: "scope has indexed chunks", pass: false, detail: testCase.scope });
  } else if (testCase.type === "code-list") {
    const list = buildStructuredCodeListAnswer(chunks, testCase.question);
    answer = list?.answer || "";
    uniqueCodeCount = list?.uniqueCodeCount ?? 0;
    results = (list?.chunks || []).slice(0, 6).map((chunk) => ({
      chunk,
      cosine: 1,
      structuredListMatch: true,
      score: 1,
    }));
    checks.push({ check: "complete-list handler answered", pass: Boolean(list) });
  } else {
    const codeTerms = extractCodeTerms(testCase.question);
    const vector = codeTerms.length
      ? new Array(chunks.find((chunk) => chunk.embedding)?.embedding?.length || 384).fill(0)
      : await embedQuestion(testCase.question);
    const ranked = rankChunks(chunks, vector, testCase.question, { topK: 6, minScore: 0.25 });
    results = ranked.results;
    answer = formatExactCodeResults(results, ranked.codeTerms)
      || results.map((result) => result.chunk.text).join("\n\n");

    if (testCase.type === "abstain") {
      checks.push({
        check: "low-confidence question abstains",
        pass: !isConfidentResult(results[0]),
        detail: results[0] ? `cosine=${results[0].cosine.toFixed(3)}, bm25=${results[0].bm25.toFixed(3)}` : "no result",
      });
    } else {
      checks.push({ check: "retrieval is confident", pass: isConfidentResult(results[0]) });
    }
  }

  for (const expected of testCase.answerIncludes || []) {
    checks.push({
      check: `answer contains ${expected}`,
      pass: includesIgnoreCase(answer, expected),
    });
  }
  if (testCase.minUniqueCodes != null) {
    checks.push({
      check: `at least ${testCase.minUniqueCodes} unique codes`,
      pass: uniqueCodeCount >= testCase.minUniqueCodes,
      detail: `${uniqueCodeCount ?? 0}`,
    });
  }
  for (const system of testCase.systems || []) {
    checks.push({ check: `includes ${system}`, pass: includesIgnoreCase(answer, system) });
  }
  if (testCase.sourcePattern) {
    const pattern = new RegExp(testCase.sourcePattern, "i");
    checks.push({
      check: `top results include source /${testCase.sourcePattern}/`,
      pass: results.some((result) => pattern.test(sourceText(result))),
      detail: results.slice(0, 3).map(sourceText).join(" | "),
    });
  }

  return {
    id: testCase.id,
    required: testCase.required !== false,
    pass: checks.every((check) => check.pass),
    checks,
    topSources: results.slice(0, 3).map(sourceText),
  };
}

const results = [];
for (const testCase of cases) {
  process.stdout.write(`Evaluating ${testCase.id}… `);
  const result = await runCase(testCase);
  results.push(result);
  console.log(result.pass ? "PASS" : result.required ? "FAIL" : "WARN");
  for (const check of result.checks.filter((item) => !item.pass)) {
    console.log(`  - ${check.check}${check.detail ? `: ${check.detail}` : ""}`);
  }
}

const required = results.filter((result) => result.required);
const passed = required.filter((result) => result.pass).length;
const report = {
  generated: new Date().toISOString(),
  model: index.model,
  queryPrefix: index.queryPrefix || "",
  index: indexPath,
  passed,
  required: required.length,
  allPassed: passed === required.length,
  results,
};
await writeFile(outputPath, JSON.stringify(report, null, 2));

const summary = [
  "## Front Desk retrieval evaluation",
  "",
  `Model: \`${index.model}\``,
  "",
  `Required checks: **${passed}/${required.length} passed**`,
  "",
  "| Case | Required | Result |",
  "|---|---:|---:|",
  ...results.map((result) => `| ${result.id} | ${result.required ? "yes" : "diagnostic"} | ${result.pass ? "PASS" : result.required ? "FAIL" : "WARN"} |`),
  "",
];
console.log(`\n${summary.join("\n")}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
}
if (!report.allPassed) process.exitCode = 1;

