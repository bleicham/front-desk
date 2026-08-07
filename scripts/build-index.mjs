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
    try {
      text = await extractText(file);
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
      isMarkdown: /\.(md|markdown)$/i.test(file),
    });
    console.log(`Indexed ${rel}`);
  }
}

async function collectWebsites(documents, websites) {
  for (const entry of websites) {
    const url = typeof entry === "string" ? entry : entry.url;
    const customTitle = typeof entry === "object" ? entry.title : null;
    if (!url) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "user-agent": "FrontDesk-indexer (+github-pages RAG)" },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") || "";
      let text, title;
      if (contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
        const { extractText: extractPdf, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
        ({ text } = await extractPdf(pdf, { mergePages: true }));
        title = customTitle || decodeURIComponent(basename(new URL(url).pathname));
      } else {
        const html = await res.text();
        const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        title = customTitle || (match ? stripHtml(match[1]).slice(0, 120) : url);
        text = stripHtml(html);
      }

      if (!text || text.length < 80) throw new Error("no extractable text");
      const u = new URL(url);
      documents.push({
        source: (u.host + u.pathname).replace(/\/$/, ""),
        title,
        link: url,
        text,
        isMarkdown: false,
      });
      console.log(`Fetched ${url}`);
    } catch (err) {
      console.warn(`Skipping website ${url}: ${err.message}`);
    }
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

async function collectRepositories(documents, repositories) {
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
        try {
          text = await extractText(file);
        } catch {
          continue;
        }
        if (!text || !text.trim()) continue;
        documents.push({
          source: `${spec.repo}/${repoPath}`,
          title: titleFor(file, text),
          link: `https://github.com/${spec.repo}/blob/${branch}/${repoPath}`,
          text,
          isMarkdown: /\.(md|markdown)$/i.test(file),
        });
        count++;
      }
      console.log(`Indexed ${count} file(s) from ${spec.repo}`);
    } catch (err) {
      console.warn(`Skipping repository ${spec.repo}: ${err.message}`);
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

  await collectKnowledgeFolder(documents);
  if (Array.isArray(sources.websites)) await collectWebsites(documents, sources.websites);
  if (Array.isArray(sources.repositories)) await collectRepositories(documents, sources.repositories);

  if (documents.length === 0) {
    console.warn("No documents found anywhere — writing empty index.");
  }

  // Chunk every document.
  const chunks = [];
  for (const doc of documents) {
    const pieces = chunkText(doc.text, doc.isMarkdown);
    for (let i = 0; i < pieces.length; i++) {
      chunks.push({
        source: doc.source,
        title: doc.title,
        link: doc.link,
        part: i,
        text: pieces[i],
      });
    }
  }

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
