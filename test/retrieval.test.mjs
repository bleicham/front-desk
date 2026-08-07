import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCodeTerms,
  findExactCodeLines,
  formatExactCodeResults,
  formatStructuredRows,
  rankChunks,
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
