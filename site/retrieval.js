const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "how",
  "what", "who", "where", "when", "why", "can", "i", "we", "you", "to",
  "of", "in", "on", "for", "and", "or", "my", "our", "it", "this", "that",
]);

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function unique(values) {
  return [...new Set(values)];
}

/** Extract identifiers that should be matched literally, not semantically. */
export function extractCodeTerms(text) {
  const value = String(text || "");
  const terms = [
    ...(value.match(/\b\d{1,6}-\d\b/g) || []),                         // LOINC
    ...(value.match(/\b[A-Za-z]\d{2}(?:\.[A-Za-z0-9]{1,4})?\b/g) || []), // ICD-10
    ...(value.match(/\b(?:\d{4}[A-Za-z]|[A-Za-z]\d{4})\b/g) || []),       // CPT/HCPCS
    ...(value.match(/(?<![A-Za-z0-9.-])\d{5}(?![A-Za-z0-9.-])/g) || []), // numeric CPT
  ];

  // Short numeric CVX codes and numeric RxCUIs are only identifiers when the
  // question names a code system (or explicitly says "code").
  if (/\b(?:code|loinc|icd(?:-?10)?|cpt|cvx|rxnorm|rxcui)\b/i.test(value)) {
    const numericSource = value.replace(/\b(?:ICD-?10|COVID-19)\b/gi, " ");
    for (const token of numericSource.match(/\b\d{2,9}\b/g) || []) {
      const number = Number(token);
      if (number >= 1900 && number <= 2099) continue; // likely a year
      if (terms.some((term) => term !== token && term.includes(token))) continue;
      terms.push(token);
    }
  }

  return unique(terms.map((term) => term.toUpperCase()));
}

function containsLiteral(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Z0-9])${escaped}($|[^A-Z0-9])`, "i").test(haystack);
}

export function findExactCodeLines(text, codeTerms) {
  if (!codeTerms.length) return [];
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && codeTerms.some((term) => containsLiteral(line, term)));
}

function getField(fields, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const match = Object.entries(fields).find(([name]) => wanted.has(name.toLowerCase()));
  return match?.[1] || "";
}

function shorten(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Parse the row-safe text emitted by build-index.mjs. */
export function parseStructuredRow(line, sheet = "") {
  if (!/^Row \d+\s*\|/i.test(String(line || ""))) return null;
  const fields = {};
  for (const part of line.split(/\s+\|\s+/).slice(1)) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    fields[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  if (!Object.keys(fields).length) return null;

  return {
    sheet,
    fields,
    code: getField(fields, "Code", "LOINC_NUM", "CVX Code", "RxCUI Code"),
    system: getField(fields, "Code Type") || sheet,
    condition: getField(fields, "Condition", "CONDITION"),
    category: getField(fields, "Drug Class/Category"),
    name: getField(fields, "Drug Name"),
    description: getField(
      fields,
      "Description",
      "LONG_COMMON_NAME",
      "CVX Short Description",
      "Full Vaccine Name",
      "COMPONENT",
      "Drug Name",
    ),
    domain: getField(fields, "Domain Type"),
    status: getField(fields, "STATUS", "VaccineStatus"),
    startDate: getField(fields, "Start Date"),
    endDate: getField(fields, "End Date"),
    method: getField(fields, "METHOD_TYP"),
    specimen: getField(fields, "SYSTEM"),
    note: getField(fields, "Note"),
  };
}

/** Convert spreadsheet rows into concise, labeled plain text for the UI. */
export function formatStructuredRows(items, options = {}) {
  const maxRecords = options.maxRecords || 20;
  const parsed = [];
  const seen = new Set();
  for (const item of items) {
    const record = parseStructuredRow(item.line, item.sheet);
    if (!record) continue;
    const key = JSON.stringify([
      record.code, record.system, record.condition, record.category,
      record.name, record.description, record.status, record.startDate, record.endDate,
    ]).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push(record);
  }
  if (!parsed.length) return null;

  const shown = parsed.slice(0, maxRecords);
  const groups = new Map();
  for (const record of shown) {
    const groupKey = `${record.code || "Match"}\u0000${record.system || ""}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(record);
  }

  const output = [];
  for (const records of groups.values()) {
    const first = records[0];
    const heading = first.code
      ? `${first.code}${first.system ? ` (${first.system})` : ""}`
      : first.system || "Matching record";
    if (output.length) output.push("");
    output.push(heading);

    for (const record of records) {
      const subject = shorten(record.condition || record.category || record.name || "Match", 100);
      const description = shorten(record.description, 260);
      output.push(`• ${subject}${description && description !== subject ? ` — ${description}` : ""}`);

      const details = [];
      if (record.domain) details.push(`Domain: ${shorten(record.domain, 80)}`);
      if (record.status) details.push(`Status: ${shorten(record.status, 80)}`);
      if (record.startDate || record.endDate) {
        details.push(`Effective: ${record.startDate || "unspecified"} to ${record.endDate || "present"}`);
      }
      if (record.method && record.method !== "-") details.push(`Method: ${shorten(record.method, 80)}`);
      if (record.specimen && record.specimen !== "-") details.push(`Specimen: ${shorten(record.specimen, 80)}`);
      if (details.length) output.push(`  ${details.join(" · ")}`);
      if (record.note) output.push(`  Note: ${shorten(record.note, 220)}`);
    }
  }

  if (parsed.length > shown.length) {
    output.push("", `${parsed.length - shown.length} additional matching record(s) are in the linked source.`);
  }
  return output.join("\n");
}

export function formatExactCodeResults(results, codeTerms, options = {}) {
  if (!codeTerms.length) return null;
  const items = results.flatMap((result) =>
    findExactCodeLines(result.chunk.text, codeTerms)
      .map((line) => ({ line, sheet: result.chunk.sheet || "" }))
  );
  return formatStructuredRows(items, options);
}

/**
 * Rank chunks with semantic similarity, lexical overlap, and literal code
 * matching. Literal matches survive the semantic threshold because sentence
 * embeddings are intentionally weak on opaque identifiers.
 */
export function rankChunks(chunks, queryVector, question, options = {}) {
  const topK = options.topK || 6;
  const exactTopK = options.exactTopK || 24;
  const minScore = options.minScore ?? 0.25;
  const terms = String(question || "").toLowerCase()
    .match(/[a-z0-9][a-z0-9._-]{2,}/g)
    ?.filter((term) => !STOPWORDS.has(term)) || [];
  const codeTerms = extractCodeTerms(question);

  const ranked = chunks
    .map((chunk) => {
      const cosine = dot(queryVector, chunk.embedding);
      const haystack = `${chunk.text || ""} ${chunk.title || ""} ${chunk.sheet || ""}`.toLowerCase();
      const hits = terms.filter((term) => haystack.includes(term)).length;
      const lexicalBoost = terms.length ? 0.15 * (hits / terms.length) : 0;
      const exactCodeMatch = codeTerms.some((term) => containsLiteral(haystack, term));
      return {
        chunk,
        cosine,
        exactCodeMatch,
        score: cosine + lexicalBoost + (exactCodeMatch ? 1 : 0),
      };
    })
    .filter((result) => result.exactCodeMatch || result.cosine >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, codeTerms.length ? exactTopK : topK);

  return { results: ranked, codeTerms };
}
