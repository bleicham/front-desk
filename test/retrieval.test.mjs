import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredCodeListAnswer,
  extractCodeTerms,
  filterChunksByScope,
  findExactCodeLines,
  formatExactCodeResults,
  formatStructuredRows,
  rankChunks,
  verifyCitedAnswer,
} from "../site/retrieval.js";

test("extracts clinical identifiers and ignores likely years", () => {
  assert.deepEqual(extractCodeTerms("What is LOINC 49656-2?"), ["49656-2"]);
  assert.deepEqual(extractCodeTerms("Look up ICD-10 B34.2"), ["B34.2"]);
  assert.deepEqual(extractCodeTerms("What is CVX code 207 in 2025?"), ["207"]);
  assert.deepEqual(extractCodeTerms("What happened in 2025?"), []);
});

test("literal code matches survive a weak semantic score and rank first", () => {
  const chunks = [
    { title: "ICD-10", text: "Condition: COVID-19 | Code: B34.2", embedding: [0, 1] },
    { title: "General", text: "General respiratory disease guidance", embedding: [1, 0] },
  ];
  const { results } = rankChunks(chunks, [1, 0], "What is ICD-10 B34.2?", { minScore: 0.25 });
  assert.equal(results[0].chunk.title, "ICD-10");
  assert.equal(results[0].exactCodeMatch, true);
});

test("returns every distinct row for a code mapped to multiple conditions", () => {
  const text = [
    "Row 2 | Condition: COVID-19 | Code: J12.82",
    "Row 40 | Condition: ARI | Code: J12.82",
    "Row 41 | Condition: Other | Code: J12.820",
  ].join("\n");
  assert.deepEqual(findExactCodeLines(text, ["J12.82"]), [
    "Row 2 | Condition: COVID-19 | Code: J12.82",
    "Row 40 | Condition: ARI | Code: J12.82",
  ]);
});

test("formats duplicate code matches as a clean labeled summary", () => {
  const results = [{
    chunk: {
      sheet: "ICD-10",
      text: [
        "Row 2 | Condition: COVID-19 | Description: Pneumonia due to coronavirus disease 2019 | Domain Type: Diagnosis | Code Type: ICD-10 | Code: J12.82",
        "Row 40 | Condition: ARI | Description: Pneumonia due to coronavirus disease 2019 | Domain Type: Diagnosis | Code Type: ICD-10 | Code: J12.82",
      ].join("\n"),
    },
  }];
  assert.equal(formatExactCodeResults(results, ["J12.82"]), [
    "J12.82 (ICD-10)",
    "• COVID-19 — Pneumonia due to coronavirus disease 2019",
    "  Domain: Diagnosis",
    "• ARI — Pneumonia due to coronavirus disease 2019",
    "  Domain: Diagnosis",
  ].join("\n"));
});

test("formats LOINC fields without dumping the full spreadsheet row", () => {
  const answer = formatStructuredRows([{
    sheet: "LOINC",
    line: "Row 2 | CONDITION: HIV | LOINC_NUM: 49656-2 | COMPONENT: HIV protease gene mutations | SYSTEM: Isolate | METHOD_TYP: Genotyping | STATUS: ACTIVE | FormalName: very long unused detail",
  }]);
  assert.equal(answer, [
    "49656-2 (LOINC)",
    "• HIV — HIV protease gene mutations",
    "  Status: ACTIVE · Method: Genotyping · Specimen: Isolate",
  ].join("\n"));
  assert.equal(answer.includes("FormalName"), false);
});

test("lists every matching code without TOP_K or display truncation", () => {
  const codes = Array.from({ length: 30 }, (_, i) => `${50000 + i}-${i % 10}`);
  const chunks = codes.map((code, i) => ({
    sheet: "LOINC",
    source: "codes.xlsx",
    text: `Row ${i + 2} | CONDITION: HIV | LOINC_NUM: ${code} | COMPONENT: HIV test ${i + 1}`,
    embedding: [1, 0],
  }));
  const result = buildStructuredCodeListAnswer(chunks, "List all LOINC codes for HIV");
  assert.equal(result.uniqueCodeCount, 30);
  assert.equal(result.answer.includes(codes[0]), true);
  assert.equal(result.answer.includes(codes.at(-1)), true);
  assert.equal(result.answer.includes("30 unique LOINC codes"), true);
});

test("groups a condition's codes across code systems", () => {
  const chunks = [
    { sheet: "LOINC", text: "Row 2 | CONDITION: HIV | LOINC_NUM: 49656-2", embedding: [1, 0] },
    { sheet: "ICD-10", text: "Row 2 | Condition: HIV | Code Type: ICD-10 | Code: B20", embedding: [1, 0] },
  ];
  const result = buildStructuredCodeListAnswer(chunks, "What are all codes for HIV?");
  assert.equal(result.answer.includes("ICD-10 (1)"), true);
  assert.equal(result.answer.includes("LOINC (1)"), true);
  assert.equal(result.answer.includes("B20"), true);
  assert.equal(result.answer.includes("49656-2"), true);
});

test("boosts indexed website pages for explicit webpage questions", () => {
  const chunks = [
    { kind: "website", title: "Hubverse", text: "Model output standards", embedding: [0.4, 0] },
    { kind: "document", title: "Manual", text: "Model output standards", embedding: [0.5, 0] },
  ];
  const { results } = rankChunks(chunks, [1, 0], "What does the Hubverse website say about model output?");
  assert.equal(results[0].chunk.kind, "website");
});

test("BM25 rescues a rare exact phrase when semantic similarity is weak", () => {
  const chunks = [
    { title: "Model tasks", text: "A model task is defined in tasks.json.", embedding: [0.1, 0] },
    { title: "General model guidance", text: "Models and forecasts", embedding: [0.8, 0] },
  ];
  const { results } = rankChunks(chunks, [1, 0], "Where is tasks.json defined?", { minScore: 0.25 });
  assert.equal(results[0].chunk.title, "Model tasks");
  assert.equal(results[0].bm25 > 0, true);
});

test("source scopes keep website, docs, and workbook retrieval separate", () => {
  const chunks = [
    { kind: "spreadsheet", sheet: "ICD-10", source: "codes.xlsx" },
    { kind: "website", source: "hubverse.io/tools/data.html", link: "https://hubverse.io/tools/data.html" },
    { kind: "website", source: "docs.hubverse.io/en/stable/", link: "https://docs.hubverse.io/en/stable/" },
  ];
  assert.deepEqual(filterChunksByScope(chunks, "codes"), [chunks[0]]);
  assert.deepEqual(filterChunksByScope(chunks, "website"), [chunks[1]]);
  assert.deepEqual(filterChunksByScope(chunks, "docs"), [chunks[2]]);
});

test("citation verification rejects unsupported generated claims", () => {
  const results = [{ chunk: { text: "Hubverse model tasks are recorded in tasks.json files." } }];
  assert.equal(
    verifyCitedAnswer("## Model tasks\nModel tasks are recorded in tasks.json files [1].", results).ok,
    true,
  );
  assert.equal(
    verifyCitedAnswer("The cafeteria closes at seven every evening [1].", results).ok,
    false,
  );
  assert.equal(
    verifyCitedAnswer("Model tasks are recorded in tasks.json files.", results).ok,
    false,
  );
});
