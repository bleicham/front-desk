const DIRECTORY_URL = "https://hubverse.io/community/hubs.html";

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
    check: "✓",
  };
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?[0-9a-f]+);/gi, (_, code) => {
      const number = code[0].toLowerCase() === "x"
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : _;
    })
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function firstLink(cell, predicate = () => true) {
  for (const match of String(cell || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = decodeHtml(match[1]);
    if (predicate(href)) return href;
  }
  return null;
}

function absoluteUrl(value, baseUrl = DIRECTORY_URL) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseInteger(value) {
  const cleaned = String(value || "").replace(/[^0-9]/g, "");
  return cleaned ? Number(cleaned) : null;
}

function normalizeHeader(value) {
  return decodeHtml(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tableRows(tableHtml) {
  return [...String(tableHtml || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((rowMatch) => [...rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((cellMatch) => cellMatch[2]))
    .filter((row) => row.length);
}

function findDirectoryTable(html) {
  for (const match of String(html || "").matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = tableRows(match[1]);
    if (!rows.length) continue;
    const headers = rows[0].map(normalizeHeader);
    if (headers.includes("hub") && headers.includes("organization") && headers.includes("category")) {
      return { headers, rows: rows.slice(1) };
    }
  }
  throw new Error("The official page did not contain the expected Hub / Organization / Category table.");
}

function fieldIndex(headers, ...names) {
  const wanted = new Set(names);
  return headers.findIndex((header) => wanted.has(header));
}

/**
 * Parse the public table that Hubverse itself publishes. The summary count is
 * treated as a checksum: an incomplete or changed table fails the build rather
 * than silently publishing a partial directory.
 */
export function parseHubverseDirectoryHtml(html, options = {}) {
  const citation = options.citation || DIRECTORY_URL;
  const { headers, rows } = findDirectoryTable(html);
  const at = (...names) => fieldIndex(headers, ...names);
  const indexes = {
    name: at("hub"),
    organization: at("organization"),
    category: at("category"),
    models: at("models"),
    dataRows: at("data rows", "rows"),
    repo: at("repo", "repository"),
    s3: at("s3 bucket", "s3"),
    insights: at("insights"),
    forecasts: at("forecasts"),
    evaluations: at("evaluations"),
  };

  const hubs = [];
  for (const cells of rows) {
    const cell = (index) => index >= 0 ? cells[index] || "" : "";
    const name = decodeHtml(cell(indexes.name));
    const organization = decodeHtml(cell(indexes.organization));
    const category = decodeHtml(cell(indexes.category));
    if (!name || !organization || !category) continue;

    const repoCell = cell(indexes.repo);
    const repoText = decodeHtml(repoCell);
    const repoLink = absoluteUrl(firstLink(repoCell, (href) => /github\.com/i.test(href)), citation);
    const repo = repoLink
      ? repoLink.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "")
      : (/private/i.test(repoText) ? null : repoText || null);

    const linkedField = (index) => absoluteUrl(firstLink(cell(index)), citation);
    const s3Text = decodeHtml(cell(indexes.s3));
    hubs.push({
      name,
      organization,
      category,
      models: parseInteger(decodeHtml(cell(indexes.models))),
      dataRows: parseInteger(decodeHtml(cell(indexes.dataRows))),
      repo,
      repoUrl: repoLink,
      isPrivate: !repoLink && /private/i.test(repoText),
      s3: /^s3:\/\//i.test(s3Text) ? s3Text : null,
      insights: linkedField(indexes.insights),
      forecasts: linkedField(indexes.forecasts),
      evaluations: linkedField(indexes.evaluations),
      citation,
      location: `List of hubs table — row “${name}”`,
    });
  }

  const pageText = decodeHtml(html);
  const summary = pageText.match(/([0-9,]+)\s+hubs?\s*[·|]\s*([0-9,]+)\s+organizations?/i);
  if (!summary) {
    throw new Error("Could not find Hubverse's published hub-count summary.");
  }
  const expectedHubCount = parseInteger(summary[1]);
  const expectedOrganizationCount = parseInteger(summary[2]);
  if (hubs.length !== expectedHubCount) {
    throw new Error(`Hubverse reports ${expectedHubCount} hubs, but only ${hubs.length} table rows were parsed.`);
  }

  const distinctOrganizations = new Set(hubs.map((hub) => hub.organization)).size;
  if (distinctOrganizations !== expectedOrganizationCount) {
    throw new Error(
      `Hubverse reports ${expectedOrganizationCount} organizations, but ${distinctOrganizations} were parsed.`,
    );
  }

  const updated = pageText.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
  return {
    citation,
    expectedHubCount,
    expectedOrganizationCount,
    updated,
    hubs,
  };
}

export function hubToIndexText(hub) {
  const fields = [
    `Hub: ${hub.name}`,
    `Organization: ${hub.organization}`,
    `Category: ${hub.category}`,
    `Models: ${hub.models ?? "not reported"}`,
    `Data rows: ${hub.dataRows ?? "not reported"}`,
    `Repository: ${hub.repo || (hub.isPrivate ? "private" : "not listed")}`,
  ];
  if (hub.s3) fields.push(`S3 bucket: ${hub.s3}`);
  if (hub.insights) fields.push(`Insights: ${hub.insights}`);
  if (hub.forecasts) fields.push(`Forecasts: ${hub.forecasts}`);
  if (hub.evaluations) fields.push(`Evaluations: ${hub.evaluations}`);
  return fields.join("\n");
}
