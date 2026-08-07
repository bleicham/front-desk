/**
 * Front Desk — index builder
 *
 * Gathers reference material from three places:
 *   1. /knowledge          — files dropped into this repo
 *   2. sources.yml → websites      — pages fetched at build time
 *   3. sources.yml → repositories  — other GitHub repos, shallow-cloned
 *
 * Extracts text, chunks it, embeds every chunk with a local
 * sentence-transformer model, and writes site/index.json for the
 * GitHub Pages front end. No API keys needed.
 */

import { readdir, readFile, writeFile, mkdir, stat, mkdtemp, rm } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { env, pipeline } from "@xenova/transformers";

// Cache the downloaded model inside the workspace so GitHub Actions
// can restore it between runs (see .github/workflows/deploy.yml).
env.cacheDir = ".model-cache";

const KNOWLEDGE_DIR = "knowledge";
const SOURCES_FILE = "sources.yml";
const OUTPUT_FILE = "site/index.json";
const MODEL = "Xenova/all-MiniLM-L6-v2";
const MAX_FILE_BYTES = 10 * 1024 * 1024; // skip anything over 10 MB
const FETCH_TIMEOUT_MS = 20000;
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 200;

const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yml", ".yaml",
  ".html", ".htm", ".rst", ".org", ".log",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "__pycache__"]);
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"]);

/* ---------------------------------------------------------------- */
/* File discovery                                                    */
/* ---------------------------------------------------------------- */

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* Text extraction                                                   */
/* ---------------------------------------------------------------- */

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(h[1-6]|p|li|tr|div|br|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

async function extractText(path) {
  const ext = extname(path).toLowerCase();

  if (ext === ".pdf") {
    const { extractText: extractPdf, getDocumentProxy } = await import("unpdf");
    const buffer = await readFile(path);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractPdf(pdf, { mergePages: true });
    return text;
  }

  if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") {
    const mod = await import("xlsx");
    const XLSX = mod.default || mod;
    const wb = XLSX.read(await readFile(path), { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
      if (csv) parts.push(`## Sheet: ${name}\n${csv}`);
    }
    return parts.join("\n\n");
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ path });
    return value;
  }

  if (ext === ".html" || ext === ".htm") {
    return stripHtml(await readFile(path, "utf8"));
  }

  if (TEXT_EXTENSIONS.has(ext)) {
    return readFile(path, "utf8");
  }

  // Extensionless docs common in repos: README, CHANGELOG, CONTRIBUTING…
  if (!ext && /^(readme|changelog|contributing|faq|install|usage|notes)$/i.test(basename(path))) {
    return readFile(path, "utf8");
  }

  return null; // unsupported type — skipped
}

function isSpreadsheet(path) {
  return /\.(xlsx|xls|xlsm)$/i.test(path);
}

/**
 * Turn workbook rows into row-safe chunks. Every chunk repeats its sheet name
 * and column labels so rows never lose their schema when they are embedded.
 */
async function extractWorkbookChunks(path) {
  const mod = await import("xlsx");
  const XLSX = mod.default || mod;
  const wb = XLSX.read(await readFile(path), { type: "buffer" });
  const chunks = [];
  const workbookTitle = basename(path).replace(/\.[^.]+$/, "");

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    if (!rows.length) continue;

    const width = Math.max(...rows.map((row) => row.length));
    const headers = Array.from({ length: width }, (_, i) => {
      const value = String(rows[0]?.[i] ?? "").replace(/\s+/g, " ").trim();
      return value || `Column ${i + 1}`;
    });
    const prefix = `## Sheet: ${sheetName}\nColumns: ${headers.join(" | ")}`;
    let lines = [];

    const flush = () => {
      if (!lines.length) return;
      chunks.push({
        sheet: sheetName,
        title: `${workbookTitle} — ${sheetName}`,
        text: `${prefix}\n${lines.join("\n")}`,
      });
      lines = [];
    };

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      const fields = headers.flatMap((header, columnIndex) => {
        const value = String(rows[rowIndex]?.[columnIndex] ?? "").replace(/\s+/g, " ").trim();
        return value ? [`${header}: ${value}`] : [];
      });
      if (!fields.length) continue;
      const rowText = `Row ${rowIndex + 1} | ${fields.join(" | ")}`;
      const candidate = `${prefix}\n${[...lines, rowText].join("\n")}`;
      if (lines.length && candidate.length > CHUNK_CHARS) flush();
      lines.push(rowText);
      if (`${prefix}\n${rowText}`.length > CHUNK_CHARS) flush();
    }
    flush();
  }

  return chunks;
}

/* ---------------------------------------------------------------- */
/* Chunking                                                          */
/* ---------------------------------------------------------------- */

function chunkText(text, isMarkdown) {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const sections = isMarkdown
    ? cleaned.split(/\n(?=#{1,4}\s)/g)
    : cleaned.split(/\n\s*\n/g);

  const chunks = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 40) chunks.push(trimmed);
    current = "";
  };

  for (const section of sections) {
    if ((current + "\n\n" + section).length <= CHUNK_CHARS) {
      current = current ? current + "\n\n" + section : section;
      continue;
    }
    flush();
    if (section.length <= CHUNK_CHARS) {
      current = section;
    } else {
      let start = 0;
      while (start < section.length) {
        const end = Math.min(start + CHUNK_CHARS, section.length);
        let cut = end;
        if (end < section.length) {
          const window = section.slice(start, end);
          const lastBreak = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
          if (lastBreak > CHUNK_CHARS * 0.5) cut = start + lastBreak + 1;
        }
        const piece = section.slice(start, cut).trim();
        if (piece.length > 40) chunks.push(piece);
        if (cut >= section.length) break;
        start = Math.max(cut - CHUNK_OVERLAP, start + 1);
      }
    }
  }
  flush();
  return chunks;
}

function titleFor(path, text) {
  const heading = text.match(/^#{1,3}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, 120);
  return basename(path).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

/* ---------------------------------------------------------------- */
/* Source collection                                                 */
/* ---------------------------------------------------------------- */

/**
 * Every collected document becomes { source, title, link, text }.
 *   source — short display path (e.g. "knowledge/faq.md", "docs.example.com/setup")
 *   link   — absolute URL for external sources; null for local files
 *            (the client builds a GitHub blob link for those)
 */

async function collectKnowledgeFolder(documents) {
  for (const file of await walk(KNOWLEDGE_DIR)) {
    const info = await stat(file);
    if (info.size > MAX_FILE_BYTES) {
      console.warn(`Skipping ${file} (larger than 10 MB)`);
      continue;
    }
    let text;
    let preparedChunks = null;
    try {
      if (isSpreadsheet(file)) {
        preparedChunks = await extractWorkbookChunks(file);
        text = preparedChunks.map((chunk) => chunk.text).join("\n\n");
      } else {
        text = await extractText(file);
      }
    } catch (err) {
      console.warn(`Skipping ${file}: ${err.message}`);
      continue;
    }
    if (!text || !text.trim()) continue;
    const rel = relative(".", file).replace(/\\/g, "/");
    documents.push({
      source: rel,
      title: titleFor(file, text),
      link: null,
      text,
      isMarkdown: /\.(md|markdown|xlsx|xls|xlsm)$/i.test(file),
      preparedChunks,
      kind: preparedChunks ? "spreadsheet" : "document",
    });
    console.log(`Indexed ${rel}`);
  }
}

async function collectWebsites(documents, websites, report) {
  const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const visited = new Set();

  async function fetchWithTimeout(url, headers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { signal: controller.signal, redirect: "follow", headers });
    } finally {
      clearTimeout(timer);
    }
  }

  function canonicalUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol)) return null;
      if (/\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|zip|gz|tar|mp4|mp3)$/i.test(url.pathname)) {
        return null;
      }
      url.hash = "";
      url.search = ""; // avoids duplicate tracking/filter URLs
      return url.toString();
    } catch {
      return null;
    }
  }

  function extractLinks(content, pageUrl) {
    const links = [];
    const patterns = [
      /\bhref\s*=\s*["']([^"']+)["']/gi,
      /\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const url = canonicalUrl(match[1].replace(/&amp;/g, "&"), pageUrl);
        if (url) links.push(url);
      }
    }
    return [...new Set(links)];
  }

  async function fetchWebsitePage(url, customTitle) {
    let text = null;
    let title = customTitle;
    let isMarkdown = false;
    let failReason = null;
    let discoveredLinks = [];

    // Attempt 1: direct fetch with a browser user agent.
    try {
      const res = await fetchWithTimeout(url, { "user-agent": BROWSER_UA, accept: "text/html,application/pdf,*/*" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
        const { extractText: extractPdf, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
        ({ text } = await extractPdf(pdf, { mergePages: true }));
        title ||= decodeURIComponent(basename(new URL(url).pathname));
      } else {
        const html = await res.text();
        discoveredLinks = extractLinks(html, url);
        const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        title ||= match ? stripHtml(match[1]).slice(0, 120) : null;
        text = stripHtml(html);
      }
    } catch (err) {
      failReason = err.message;
    }

    // Attempt 2: if the page was blocked or is JavaScript-rendered (thin
    // HTML), route through the free r.jina.ai reader.
    if (!text || text.length < 200) {
      try {
        console.log(`  ${url} → thin/blocked (${failReason || (text ? text.length + " chars" : "no text")}), trying reader fallback…`);
        const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { accept: "text/markdown, text/plain" });
        if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
        const md = await res.text();
        if (md && md.trim().length >= 200) {
          text = md.trim();
          isMarkdown = true;
          discoveredLinks.push(...extractLinks(md, url));
          const heading = md.match(/^Title:\s*(.+)$/m) || md.match(/^#\s+(.+)$/m);
          title ||= heading ? heading[1].trim().slice(0, 120) : null;
          failReason = null;
        }
      } catch (err) {
        failReason = failReason ? `${failReason}; reader: ${err.message}` : `reader: ${err.message}`;
      }
    }

    if (!text || text.trim().length < 80) {
      return { error: failReason || "no extractable text (JavaScript-only page?)", links: discoveredLinks };
    }
    return { text, title: title || url, isMarkdown, links: [...new Set(discoveredLinks)] };
  }

  for (const entry of websites) {
    const spec = typeof entry === "string" ? { url: entry } : entry;
    const root = canonicalUrl(spec.url);
    if (!root) continue;
    const rootUrl = new URL(root);
    const pathPrefix = spec.pathPrefix || (rootUrl.pathname.endsWith("/")
      ? rootUrl.pathname
      : rootUrl.pathname.replace(/[^/]+$/, ""));
    const maxPages = spec.crawl ? Math.max(1, Math.min(Number(spec.maxPages) || 25, 100)) : 1;
    const queue = [root];
    let fetchedCount = 0;

    while (queue.length && fetchedCount < maxPages) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);

      const page = await fetchWebsitePage(url, url === root ? spec.title : null);
      if (page.error) {
        console.warn(`Skipping website ${url}: ${page.error}`);
        report.websitesFailed.push({ url, reason: page.error });
        continue;
      }

      const current = new URL(url);
      documents.push({
        source: (current.host + current.pathname).replace(/\/$/, ""),
        title: page.title,
        link: url,
        text: page.text,
        isMarkdown: page.isMarkdown,
        kind: "website",
      });
      report.websitesOk.push(url);
      fetchedCount++;
      console.log(`Fetched ${url} (${page.text.length} chars)`);

      if (spec.crawl) {
        for (const link of page.links) {
          const candidate = new URL(link);
          if (candidate.origin !== rootUrl.origin || !candidate.pathname.startsWith(pathPrefix)) continue;
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    }
    if (spec.crawl) console.log(`Crawled ${fetchedCount} page(s) from ${root}`);
  }
}

function matchesFilters(path, include, exclude) {
  const test = (patterns) =>
    patterns.some((p) =>
      p.startsWith("*.") ? path.toLowerCase().endsWith(p.slice(1).toLowerCase())
                         : path.startsWith(p.replace(/\/?\*?\*?$/, "").replace(/\/$/, "") + "/")
                           || path === p
    );
  if (exclude && exclude.length && test(exclude)) return false;
  if (include && include.length) return test(include);
  return true;
}

async function collectRepositories(documents, repositories, report) {
  const token = process.env.REPOS_TOKEN || "";
  for (const entry of repositories) {
    const spec = typeof entry === "string" ? { repo: entry } : entry;
    if (!spec.repo) continue;
    const include = spec.include
      ? (Array.isArray(spec.include) ? spec.include : [spec.include])
      : null;
    const exclude = spec.exclude
      ? (Array.isArray(spec.exclude) ? spec.exclude : [spec.exclude])
      : null;

    const cloneUrl = token
      ? `https://x-access-token:${token}@github.com/${spec.repo}.git`
      : `https://github.com/${spec.repo}.git`;

    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), "frontdesk-"));
      console.log(`Cloning ${spec.repo}…`);
      execFileSync("git", ["clone", "--depth", "1", "--quiet", cloneUrl, dir], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      const branch = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])
        .toString().trim() || "main";

      let count = 0;
      for (const file of await walk(dir)) {
        const repoPath = relative(dir, file).replace(/\\/g, "/");
        if (!matchesFilters(repoPath, include, exclude)) continue;
        const info = await stat(file);
        if (info.size > MAX_FILE_BYTES) continue;
        let text;
        let preparedChunks = null;
        try {
          if (isSpreadsheet(file)) {
            preparedChunks = await extractWorkbookChunks(file);
            text = preparedChunks.map((chunk) => chunk.text).join("\n\n");
          } else {
            text = await extractText(file);
          }
        } catch {
          continue;
        }
        if (!text || !text.trim()) continue;
        documents.push({
          source: `${spec.repo}/${repoPath}`,
          title: titleFor(file, text),
          link: `https://github.com/${spec.repo}/blob/${branch}/${repoPath}`,
          text,
          isMarkdown: /\.(md|markdown|xlsx|xls|xlsm)$/i.test(file),
          preparedChunks,
          kind: "repository",
        });
        count++;
      }
      console.log(`Indexed ${count} file(s) from ${spec.repo}`);
      report.reposOk.push(`${spec.repo} (${count} files)`);
    } catch (err) {
      console.warn(`Skipping repository ${spec.repo}: ${err.message}`);
      report.reposFailed.push({ repo: spec.repo, reason: err.message.split("\n")[0].slice(0, 200) });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function loadSources() {
  try {
    const text = await readFile(SOURCES_FILE, "utf8");
    return parseYaml(text) || {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------- */
/* Main                                                              */
/* ---------------------------------------------------------------- */

async function main() {
  const sources = await loadSources();
  const documents = [];
  const report = { websitesOk: [], websitesFailed: [], reposOk: [], reposFailed: [] };

  await collectKnowledgeFolder(documents);

  const websiteList = Array.isArray(sources.websites) ? sources.websites.filter(Boolean) : [];
  if (websiteList.length) {
    await collectWebsites(documents, websiteList, report);
  } else {
    console.log("sources.yml: no website entries found (are the examples still commented out?)");
  }

  const repoList = Array.isArray(sources.repositories) ? sources.repositories.filter(Boolean) : [];
  if (repoList.length) await collectRepositories(documents, repoList, report);

  if (documents.length === 0) {
    console.warn("No documents found anywhere — writing empty index.");
  }

  // Chunk every document.
  const chunks = [];
  for (const doc of documents) {
    const pieces = doc.preparedChunks || chunkText(doc.text, doc.isMarkdown).map((text) => ({ text }));
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      chunks.push({
        source: doc.source,
        title: piece.title || doc.title,
        link: doc.link,
        part: i,
        text: piece.text,
        kind: doc.kind || "document",
        ...(piece.sheet ? { sheet: piece.sheet } : {}),
      });
    }
  }

  if (chunks.length > 0) {
  console.log(`\nEmbedding ${chunks.length} chunks with ${MODEL}…`);
  const embed = await pipeline("feature-extraction", MODEL, { quantized: true });

  const BATCH = 16;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const output = await embed(
      batch.map((c) => c.text),
      { pooling: "mean", normalize: true }
    );
    const dims = output.dims[1];
    const flat = output.data;
    batch.forEach((chunk, j) => {
      const vec = new Array(dims);
      for (let k = 0; k < dims; k++) {
        vec[k] = Math.round(flat[j * dims + k] * 1e5) / 1e5;
      }
      chunk.embedding = vec;
    });
    console.log(`  ${Math.min(i + BATCH, chunks.length)} / ${chunks.length}`);
  }
  }

  const repo = process.env.GITHUB_REPOSITORY || "";
  const branch = (process.env.GITHUB_REF_NAME || "main").replace(/\//g, "%2F");

  const index = {
    model: MODEL,
    generated: new Date().toISOString(),
    repo,
    branch,
    documentCount: new Set(chunks.map((c) => c.source)).size,
    chunks: chunks.map((c, i) => ({ id: i, ...c })),
  };

  await mkdir("site", { recursive: true });
  const json = JSON.stringify(index);
  await writeFile(OUTPUT_FILE, json);
  console.log(
    `\nWrote ${OUTPUT_FILE} (${(json.length / 1024 / 1024).toFixed(2)} MB, ` +
    `${chunks.length} chunks from ${index.documentCount} documents)`
  );

  // Visible build report on the workflow run page (Actions → run → Summary).
  if (process.env.GITHUB_STEP_SUMMARY) {
    const knowledgeCount = documents.filter((d) => !d.link).length;
    const lines = [
      "## 🛎️ Front Desk index report",
      "",
      `| Source | Indexed |`,
      `|---|---|`,
      "| `knowledge/` files | " + knowledgeCount + " |",
      `| Websites | ${report.websitesOk.length} |`,
      `| External repos | ${report.reposOk.length} |`,
      `| **Total passages** | **${chunks.length}** |`,
      "",
    ];
    if (report.websitesOk.length) {
      lines.push("**Websites indexed:**", ...report.websitesOk.map((u) => `- ✅ ${u}`), "");
    }
    if (report.websitesFailed.length) {
      lines.push("**Websites that failed:**", ...report.websitesFailed.map((f) => `- ❌ ${f.url} — ${f.reason}`), "");
    }
    if (report.reposOk.length) {
      lines.push("**Repos indexed:**", ...report.reposOk.map((r) => `- ✅ ${r}`), "");
    }
    if (report.reposFailed.length) {
      lines.push("**Repos that failed:**", ...report.reposFailed.map((f) => `- ❌ ${f.repo} — ${f.reason}`), "");
    }
    if (!report.websitesOk.length && !report.websitesFailed.length) {
      lines.push("> No website entries found in `sources.yml` — if you added some, check they're uncommented and indented under `websites:`.", "");
    }
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
