const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "how",
  "what", "who", "where", "when", "why", "can", "i", "we", "you", "to",
  "of", "in", "on", "for", "and", "or", "my", "our", "it", "this", "that",
]);

const TOKEN_PATTERN = /[a-z0-9]+(?:[._-][a-z0-9]+)*/g;

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function unique(values) {
  return [...new Set(values)];
}

function searchTokens(value) {
  const raw = String(value || "").toLowerCase().match(TOKEN_PATTERN) || [];
  const expanded = raw.flatMap((token) => {
    const parts = token.split(/[._-]+/).filter((part) => part.length >= 2);
    return parts.length > 1 ? [token, ...parts] : [token];
  });
  return expanded.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function tokenCounts(value, weight = 1, counts = new Map()) {
  for (const token of searchTokens(value)) {
    counts.set(token, (counts.get(token) || 0) + weight);
  }
  return counts;
}

/** Limit retrieval to the source family selected in the interface. */
export function filterChunksByScope(chunks, scope = "auto") {
  if (!scope || scope === "auto") return chunks;
  return chunks.filter((chunk) => {
    if (scope === "codes") return chunk.kind === "spreadsheet" || Boolean(chunk.sheet);
    if (scope === "docs") {
      return chunk.kind === "website" && /(^|\.)docs\.hubverse\.io$/i.test(sourceHost(chunk));
    }
    if (scope === "website") {
      return (chunk.kind === "website" || chunk.kind === "hub-directory")
        && /(^|\.)hubverse\.io$/i.test(sourceHost(chunk))
        && !/(^|\.)docs\.hubverse\.io$/i.test(sourceHost(chunk));
    }
    return true;
  });
}

function hubDirectoryChunks(chunks) {
  const seen = new Set();
  return chunks.filter((chunk) => {
    if (chunk.kind !== "hub-directory" || !chunk.hub?.name) return false;
    const key = `${chunk.hub.name}\u0000${chunk.hub.organization}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requestedHubCategory(question) {
  if (/\barchiv(?:al|ed|e)\b/i.test(question)) return "Archival";
  if (/\btraining\b/i.test(question)) return "Training";
  if (/\bmodel\s+development\b/i.test(question)) return "Model Development";
  if (/\bactive\b/i.test(question)) return "Active";
  return null;
}

/**
 * Answer directory/list questions directly from every verified Hubverse row.
 * This bypasses TOP_K retrieval so a complete list can never be truncated.
 */
export function buildStructuredHubDirectoryAnswer(chunks, question) {
  const directoryChunks = hubDirectoryChunks(chunks);
  if (!directoryChunks.length || !/\bhubs\b/i.test(question)) return null;
  const listIntent = /\b(?:what|which|list|show|available|all|any|find|have|has)\b|\bare\s+there\b/i.test(question);
  if (!listIntent) return null;

  const category = requestedHubCategory(question);
  const generic = new Set([
    "active", "all", "any", "are", "available", "current", "currently",
    "development", "directory", "find", "has", "have", "hub", "hubs",
    "hubverse", "list", "listed", "model", "models", "show", "there",
    "training", "archival", "archived", "what", "which",
  ]);
  const filterTerms = searchTokens(question).filter((term) => !generic.has(term));
  let selected = directoryChunks;
  if (category) {
    selected = selected.filter((chunk) => chunk.hub.category.toLowerCase() === category.toLowerCase());
  }
  if (filterTerms.length) {
    selected = selected.filter((chunk) => {
      const haystack = searchTokens([
        chunk.hub.name,
        chunk.hub.organization,
        chunk.hub.category,
        chunk.text,
      ].join(" "));
      const words = new Set(haystack);
      return filterTerms.every((term) => words.has(term));
    });
  }

  const updated = directoryChunks.find((chunk) => chunk.sourceUpdated)?.sourceUpdated || null;
  const descriptor = category ? `${category.toLowerCase()} hubs` : "hubs";
  const intro = filterTerms.length
    ? `${selected.length.toLocaleString()} ${descriptor} match “${filterTerms.join(" ")}” in the verified Hubverse directory.`
    : `${selected.length.toLocaleString()} ${descriptor} ${selected.length === 1 ? "is" : "are"} listed in the verified Hubverse directory.`;
  const output = [intro + (updated ? ` Source updated ${updated}.` : "")];

  const categoryOrder = ["Active", "Archival", "Training", "Model Development"];
  const groups = new Map();
  for (const chunk of selected) {
    const key = chunk.hub.category || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chunk.hub);
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });
  for (const [group, hubs] of orderedGroups) {
    hubs.sort((a, b) => a.name.localeCompare(b.name));
    output.push("", `${group} (${hubs.length.toLocaleString()})`);
    for (const hub of hubs) {
      const details = [];
      if (hub.isPrivate) details.push("private");
      if (hub.models != null) details.push(`${hub.models.toLocaleString()} model${hub.models === 1 ? "" : "s"}`);
      if (hub.dataRows != null) details.push(`${hub.dataRows.toLocaleString()} data rows`);
      output.push(`• ${hub.name} — ${hub.organization}${details.length ? ` (${details.join("; ")})` : ""}`);
    }
  }

  const first = directoryChunks[0];
  const citationChunk = {
    ...first,
    title: "Hubverse — List of hubs",
    text: `Official directory table containing ${directoryChunks.length} verified hub rows.`,
    location: `List of hubs table — all ${directoryChunks.length} rows`,
  };
  return {
    answer: output.join("\n"),
    chunks: [citationChunk],
    hubCount: selected.length,
    sourceHubCount: directoryChunks.length,
  };
}

function sourceHost(chunk) {
  const candidate = chunk.link || (String(chunk.source || "").startsWith("http")
    ? chunk.source
    : `https://${chunk.source || ""}`);
  try {
    return new URL(candidate).hostname;
  } catch {
    return "";
  }
}

function normalizedSystemName(value) {
  return normalizedWords(value).join("");
}

function sourceRowsForSystem(chunks, system) {
  const wanted = normalizedSystemName(system);
  const rows = [];
  for (const chunk of chunks) {
    if (!/sources?\s*[-–—]\s*general\s+code\s+lists?/i.test(chunk.sheet || "")) continue;
    let currentSystem = "";
    for (const line of String(chunk.text || "").split(/\n+/)) {
      const record = parseStructuredRow(line, chunk.sheet);
      if (!record) continue;
      const codeName = getField(record.fields, "Code name", "Code Name");
      if (codeName) currentSystem = codeName;
      if (normalizedSystemName(currentSystem) !== wanted) continue;
      const source = getField(record.fields, "Source");
      const notes = getField(record.fields, "Notes");
      const rowNumber = Number(line.match(/^Row\s+(\d+)/i)?.[1] || 0);
      if (source) rows.push({ source, notes, rowNumber, chunk });
    }
  }
  const seen = new Set();
  return rows.filter((row) => {
    if (seen.has(row.source)) return false;
    seen.add(row.source);
    return true;
  });
}

function sheetRows(chunks, system) {
  const wanted = normalizedSystemName(system);
  return chunks.filter((chunk) => chunk.sheet && normalizedSystemName(chunk.sheet) === wanted);
}

function navigationFields(system, headers) {
  const preferred = {
    "icd10": ["Code", "Condition", "Description", "Start Date", "End Date"],
    "loinc": ["LOINC_NUM", "CONDITION", "COMPONENT", "SYSTEM", "METHOD_TYP"],
    "cpt": ["Code", "Condition", "Description", "Domain Type"],
    "cvx": ["CVX Code", "Condition", "CVX Short Description", "VaccineStatus"],
    "rxnorm": ["RxCUI Code", "Drug Class/Category", "Drug Name"],
    "socialhistory": ["Code", "Condition", "Description", "Code Type"],
  }[normalizedSystemName(system)] || [];
  const available = new Map(headers.map((header) => [header.toLowerCase(), header]));
  return preferred.map((name) => available.get(name.toLowerCase())).filter(Boolean);
}

function markdownSectionsForSystem(chunks, system) {
  const wanted = normalizedSystemName(system);
  const matches = [];
  for (const chunk of chunks) {
    if (!/(?:^|\/)readme(?:-[^/]*)?\.md$/i.test(chunk.source || "")) continue;
    if (!String(chunk.text || "").toLowerCase().includes(system.toLowerCase())) continue;
    const heading = String(chunk.text || "").match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || "README passage";
    const lines = String(chunk.text || "").split(/\n+/).filter((line) => {
      if (!line.toLowerCase().includes(system.toLowerCase())) return false;
      return normalizedSystemName(line).includes(wanted);
    });
    matches.push({ chunk, heading, lines });
  }
  return matches;
}

/**
 * Deterministically answer navigation/provenance questions such as
 * “Where can I pull ICD-10 codes from the source?” using the actual indexed
 * file path, sheet name, columns, README sections, and source URLs.
 */
export function buildSourceLocationAnswer(chunks, question) {
  const systems = requestedSystems(question);
  const provenanceIntent = /\b(?:source|sources|url|urls|website|websites|links?|upstream|official|origin|provenance)\b/i.test(question)
    || /\bpull\b[\s\S]*\bfrom\b/i.test(question);
  const repositoryIntent = /\b(?:file|workbook|sheet|tab|located|location|repository|repo)\b/i.test(question);
  const locationIntent = provenanceIntent
    || repositoryIntent
    || /\b(?:where|pull|download|access|find|get)\b/i.test(question);
  const codeIntent = systems.length || /\b(?:clinical\s+codes?|code\s+lists?|codes?)\b/i.test(question);
  if (!locationIntent || !codeIntent) return null;

  const availableSystems = ["ICD-10", "LOINC", "CPT", "CVX", "RXNorm", "Social History"]
    .filter((system) => sheetRows(chunks, system).length);
  const selectedSystems = systems.length ? systems.filter((system) => sheetRows(chunks, system).length) : availableSystems;
  if (!selectedSystems.length) return null;

  const answer = [];
  const citations = [];
  for (const system of selectedSystems) {
    const codeChunks = sheetRows(chunks, system);
    const source = codeChunks[0].source;
    const rowNumbers = codeChunks.flatMap((chunk) =>
      [...String(chunk.text || "").matchAll(/^Row\s+(\d+)\s*\|/gmi)].map((match) => Number(match[1]))
    );
    const maxRow = rowNumbers.length ? Math.max(...rowNumbers) : null;
    const headers = String(codeChunks[0].text || "")
      .match(/^Columns:\s*(.+)$/mi)?.[1]?.split(/\s+\|\s+/).map((value) => value.trim()) || [];
    const fields = navigationFields(system, headers);
    const provenance = sourceRowsForSystem(chunks, system).sort((a, b) => {
      const priority = (row) => /\b(?:official|recommend starting|maintained by (?:the )?cdc)\b|cms\.gov/i.test(`${row.notes} ${row.source}`) ? 0 : 1;
      return priority(a) - priority(b) || a.rowNumber - b.rowNumber;
    });

    if (answer.length) answer.push("");
    if (provenanceIntent && provenance.length) {
      answer.push(`${system} source URLs`);
      for (const row of provenance) {
        answer.push(`• ${row.source}${row.notes ? ` — ${shorten(row.notes, 180)}` : ""}`);
      }
      if (system === "ICD-10") {
        answer.push("• Recommendation: start with the official CMS annual code lists, then use AAPC as a searchable cross-check.");
      }
      answer.push("", "Protocol-selected codes already loaded in this repository");
    } else {
      answer.push(`${system} code location`);
    }
    answer.push(`• File: ${source}`);
    answer.push(`• Tab: ${codeChunks[0].sheet}`);
    if (maxRow) answer.push(`• Range: rows 1–${maxRow} (${Math.max(0, maxRow - 1).toLocaleString()} data rows plus the header)`);
    if (fields.length) answer.push(`• Use these fields: ${fields.join(", ")}`);
    if (system === "ICD-10") {
      answer.push("• Pull identifiers from the Code column; filter by Condition and verify the Description and any Start Date/End Date restrictions.");
    }

    const codeCitation = {
      ...codeChunks[0],
      title: `${system} code list`,
      text: `${system} codes in ${source}, tab ${codeChunks[0].sheet}${maxRow ? `, rows 1–${maxRow}` : ""}.`,
      location: `Sheet “${codeChunks[0].sheet}”${maxRow ? ` — rows 1–${maxRow}` : ""}`,
    };

    if (provenance.length) {
      if (!provenanceIntent) {
        answer.push("• Original/verification sources:");
        for (const row of provenance) {
          answer.push(`  - ${row.source}${row.notes ? ` — ${shorten(row.notes, 180)}` : ""}`);
        }
      }
      const minRow = Math.min(...provenance.map((row) => row.rowNumber));
      const maxSourceRow = Math.max(...provenance.map((row) => row.rowNumber));
      const sourceCitation = {
        ...provenance[0].chunk,
        title: `${system} provenance sources`,
        text: provenance.map((row) => `${row.source}${row.notes ? ` — ${row.notes}` : ""}`).join("\n"),
        location: `Sheet “${provenance[0].chunk.sheet}” — ${minRow === maxSourceRow ? `row ${minRow}` : `rows ${minRow}–${maxSourceRow}`}`,
      };
      if (provenanceIntent) citations.push(sourceCitation, codeCitation);
      else citations.push(codeCitation, sourceCitation);
    } else {
      citations.push(codeCitation);
    }

    const readmeSections = markdownSectionsForSystem(chunks, system);
    if (readmeSections.length) {
      const sectionNames = unique(readmeSections.map((item) => item.heading));
      answer.push(`• Protocol README: ${sectionNames.map((name) => `“${name}”`).join(", ")}`);
      citations.push({
        ...readmeSections[0].chunk,
        title: `Protocol README — ${system}`,
        text: readmeSections.flatMap((item) => item.lines).join("\n").slice(0, 1200),
        location: `Sections ${sectionNames.map((name) => `“${name}”`).join(", ")}`,
      });
    }
  }

  return {
    answer: answer.join("\n"),
    chunks: citations,
    systems: selectedSystems,
  };
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

function normalizedWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function conditionScore(label, question, questionTokens) {
  const words = normalizedWords(label).filter((word) => word !== "all");
  if (!words.length) return 0;
  const normalizedLabel = words.join(" ");
  const normalizedQuestion = normalizedWords(question).join(" ");
  if (normalizedQuestion.includes(normalizedLabel)) return 100 + words.length;

  const aliasPairs = [
    ["flu", "influenza"], ["coronavirus", "covid"], ["covid19", "covid"],
    ["tb", "tuberculosis"], ["monkeypox", "mpox"],
    ["hepatitis c", "hcv"], ["herpes simplex", "hsv"],
    ["human papillomavirus", "hpv"], ["respiratory syncytial virus", "rsv"],
  ];
  for (const [alias, canonical] of aliasPairs) {
    if (normalizedQuestion.includes(alias) && normalizedLabel.includes(canonical)) return 80;
    if (normalizedQuestion.includes(canonical) && normalizedLabel.includes(alias)) return 80;
  }

  const meaningful = words.filter((word) => word.length >= 3 || /^\d+$/.test(word));
  const matches = meaningful.filter((word) => questionTokens.has(word)).length;
  if (matches === meaningful.length && matches > 0) return 50 + matches;
  return matches;
}

function requestedSystems(question) {
  const systems = [];
  if (/\bloinc\b/i.test(question)) systems.push("LOINC");
  if (/\bicd(?:-?10)?\b/i.test(question)) systems.push("ICD-10");
  if (/\bcpt\b/i.test(question)) systems.push("CPT");
  if (/\bcvx\b/i.test(question)) systems.push("CVX");
  if (/\b(?:rxnorm|rxcui)\b/i.test(question)) systems.push("RXNorm");
  if (/\bsocial history\b/i.test(question)) systems.push("Social History");
  return systems;
}

function systemMatches(record, systems) {
  if (!systems.length) return true;
  const names = [record.system, record.sheet].map((value) => normalizedWords(value).join(""));
  return systems.some((system) => names.includes(normalizedWords(system).join("")));
}

/**
 * Deterministically answer requests such as "list all LOINC codes for HIV".
 * This scans every indexed spreadsheet row, so the result is not limited by
 * semantic TOP_K or passage-size caps.
 */
export function buildStructuredCodeListAnswer(chunks, question) {
  if (extractCodeTerms(question).length) return null;
  const asksForCodes = /\b(?:code|codes|loinc|icd(?:-?10)?|cpt|cvx|rxnorm|rxcui)\b/i.test(question);
  const listIntent = /\b(?:all|list|show|give|which|what|codes?\s+for)\b/i.test(question);
  if (!asksForCodes || !listIntent) return null;

  const systems = requestedSystems(question);
  const allRecords = [];
  const matchingChunks = [];
  for (const chunk of chunks) {
    if (!chunk.sheet) continue;
    let chunkMatched = false;
    for (const line of String(chunk.text || "").split(/\n+/)) {
      const record = parseStructuredRow(line, chunk.sheet);
      if (!record?.code || !systemMatches(record, systems)) continue;
      allRecords.push({ record, chunk });
      chunkMatched = true;
    }
    if (chunkMatched) matchingChunks.push(chunk);
  }
  if (!allRecords.length) return null;

  const questionTokens = new Set(normalizedWords(question));
  const labelMap = new Map();
  for (const { record } of allRecords) {
    const label = record.condition || record.category;
    const key = normalizedWords(label).join(" ");
    if (key && !labelMap.has(key)) labelMap.set(key, label);
  }
  const scoredLabels = [...labelMap.entries()]
    .map(([key, label]) => ({ key, label, score: conditionScore(label, question, questionTokens) }))
    .filter(({ score }) => score > 0);
  const bestScore = Math.max(0, ...scoredLabels.map(({ score }) => score));
  const selectedLabelKeys = new Set(scoredLabels.filter(({ score }) => score === bestScore).map(({ key }) => key));

  // "All LOINC codes" is valid without a condition. Otherwise require a
  // recognizable condition/category so an ordinary prose question does not
  // accidentally dump the entire workbook.
  if (!selectedLabelKeys.size && !(systems.length && /\ball\b/i.test(question))) return null;

  const selected = allRecords.filter(({ record }) => {
    const label = record.condition || record.category;
    return !selectedLabelKeys.size || selectedLabelKeys.has(normalizedWords(label).join(" "));
  });
  const groups = new Map();
  for (const { record } of selected) {
    const system = record.system || record.sheet || "Codes";
    if (!groups.has(system)) groups.set(system, new Set());
    groups.get(system).add(record.code);
  }
  if (!groups.size) return null;

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const groupEntries = [...groups.entries()]
    .map(([system, codes]) => [system, [...codes].sort(collator.compare)])
    .sort(([a], [b]) => a.localeCompare(b));
  const total = groupEntries.reduce((sum, [, codes]) => sum + codes.length, 0);
  const subject = selectedLabelKeys.size
    ? [...selectedLabelKeys].map((key) => labelMap.get(key)).join(" and ")
    : "All indexed records";
  const onlySystem = groupEntries.length === 1 ? groupEntries[0][0] : null;
  const output = [
    `${subject} — ${total.toLocaleString()} unique${onlySystem ? ` ${onlySystem}` : ""} code${total === 1 ? "" : "s"}`,
  ];

  for (const [system, codes] of groupEntries) {
    output.push("", `${system} (${codes.length.toLocaleString()})`);
    for (let i = 0; i < codes.length; i += 12) {
      output.push(codes.slice(i, i + 12).join(", "));
    }
  }

  const selectedChunkSet = new Set(selected.map(({ chunk }) => chunk));
  return {
    answer: output.join("\n"),
    chunks: matchingChunks.filter((chunk) => selectedChunkSet.has(chunk)),
    recordCount: selected.length,
    uniqueCodeCount: total,
  };
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
  const terms = unique(searchTokens(question));
  const codeTerms = extractCodeTerms(question);
  const websiteIntent = /\b(?:website|webpage|web page|site|hubverse)\b/i.test(question);
  const readmeIntent = /\b(?:readme|protocol)\b/i.test(question);

  // BM25 gives rare exact words and acronyms real weight. Titles, sheet names,
  // and source paths count more than ordinary body occurrences.
  const documents = chunks.map((chunk) => {
    const counts = tokenCounts(chunk.text, 1);
    tokenCounts(chunk.title, 2.4, counts);
    tokenCounts(chunk.sheet, 2, counts);
    tokenCounts(chunk.source, 1.2, counts);
    const length = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
    return { chunk, counts, length };
  });
  const averageLength = documents.length
    ? documents.reduce((sum, document) => sum + document.length, 0) / documents.length
    : 1;
  const frequencies = new Map(terms.map((term) => [
    term,
    documents.reduce((count, document) => count + Number(document.counts.has(term)), 0),
  ]));
  const k1 = 1.2;
  const b = 0.75;
  const candidates = documents.map(({ chunk, counts, length }) => {
    const cosine = dot(queryVector || [], chunk.embedding || []);
    let bm25 = 0;
    let lexicalHits = 0;
    for (const term of terms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      lexicalHits++;
      const df = frequencies.get(term) || 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * length / averageLength);
      bm25 += idf * (tf * (k1 + 1)) / denominator;
    }
    const haystack = `${chunk.text || ""} ${chunk.title || ""} ${chunk.sheet || ""}`;
    return {
      chunk,
      cosine,
      bm25,
      lexicalCoverage: terms.length ? lexicalHits / terms.length : 0,
      exactCodeMatch: codeTerms.some((term) => containsLiteral(haystack, term)),
    };
  });

  const semanticOrder = [...candidates].sort((a, b) => b.cosine - a.cosine);
  const lexicalOrder = candidates.filter((item) => item.bm25 > 0).sort((a, b) => b.bm25 - a.bm25);
  const semanticRanks = new Map(semanticOrder.map((item, index) => [item, index + 1]));
  const lexicalRanks = new Map(lexicalOrder.map((item, index) => [item, index + 1]));
  const rrfK = 60;

  const ranked = candidates
    .map((result) => {
      const semanticRank = semanticRanks.get(result);
      const lexicalRank = lexicalRanks.get(result);
      const semanticRrf = semanticRank ? 1 / (rrfK + semanticRank) : 0;
      const lexicalRrf = lexicalRank ? 1 / (rrfK + lexicalRank) : 0;
      const sourceBoost = websiteIntent && result.chunk.kind === "website" ? 0.012 : 0;
      const readmeBoost = readmeIntent && /(?:^|\/)readme(?:-[^/]*)?\.md$/i.test(result.chunk.source || "")
        ? 0.05
        : 0;
      return {
        ...result,
        semanticRank,
        lexicalRank: lexicalRank || null,
        score: semanticRrf + lexicalRrf + sourceBoost + readmeBoost + (result.exactCodeMatch ? 1 : 0),
      };
    })
    .filter((result) => result.exactCodeMatch || result.cosine >= minScore || result.bm25 > 0)
    .sort((a, b) => b.score - a.score || b.cosine - a.cosine)
    .slice(0, codeTerms.length ? exactTopK : topK);

  return { results: ranked, codeTerms };
}

/** A shared confidence rule for the browser, issue agent, and evaluator. */
export function isConfidentResult(result) {
  if (!result) return false;
  return Boolean(
    result.exactCodeMatch
    || result.structuredListMatch
    || result.cosine >= 0.32
    || (result.bm25 >= 1.2 && result.lexicalCoverage >= 0.5)
  );
}

/**
 * Verify that every substantive generated sentence cites at least one retrieved
 * passage and shares meaningful words with the cited passage. This deliberately
 * favors a safe extractive fallback over an unsupported fluent answer.
 */
export function verifyCitedAnswer(answer, results) {
  const unsupported = [];
  const sentences = String(answer || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    if (/^#{1,6}\s/.test(sentence) || /^\*\*[^*]+\*\*:?$/.test(sentence)) continue;
    const tokens = unique(searchTokens(sentence.replace(/\[\d+\]/g, "")))
      .filter((token) => token.length >= 3);
    if (tokens.length < 4) continue;

    const citations = [...sentence.matchAll(/\[(\d+)\]/g)]
      .map((match) => Number(match[1]) - 1)
      .filter((index) => index >= 0 && index < results.length);
    if (!citations.length) {
      unsupported.push({ sentence, reason: "missing citation" });
      continue;
    }

    const supportTokens = new Set(citations.flatMap((index) => searchTokens(results[index].chunk.text)));
    const overlap = tokens.filter((token) => supportTokens.has(token)).length;
    const coverage = overlap / tokens.length;
    if (overlap < 2 || coverage < 0.35) {
      unsupported.push({ sentence, reason: `weak cited-word overlap (${Math.round(coverage * 100)}%)` });
    }
  }

  return { ok: sentences.length > 0 && unsupported.length === 0, unsupported };
}
