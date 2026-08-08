/**
 * Front Desk — client
 *
 * 1. Loads index.json (built by GitHub Actions from /knowledge).
 * 2. Embeds the visitor's question in the browser with transformers.js —
 *    same model used at build time, so vectors are comparable. Free.
 * 3. Ranks chunks by cosine similarity and shows the best passages,
 *    each linking back to its source file on GitHub.
 * 4. Uses deterministic handlers for complete code and Hubverse directory
 *    lists; all other answers are extractive, so the site never invents text.
 */

import {
  buildStructuredCodeListAnswer,
  buildStructuredHubDirectoryAnswer,
  filterChunksByScope,
  formatExactCodeResults,
  formatStructuredRows,
  isConfidentResult,
  rankChunks,
} from "./retrieval.js";

const CONFIG = window.FRONT_DESK || {};
const TOP_K = 6;
const MIN_SCORE = 0.25;

const els = {
  orgName: document.getElementById("org-name"),
  tagline: document.getElementById("tagline"),
  subtitle: document.getElementById("subtitle"),
  form: document.getElementById("ask-form"),
  question: document.getElementById("question"),
  askButton: document.getElementById("ask-button"),
  sourceScope: document.getElementById("source-scope"),
  chips: document.getElementById("chips"),
  status: document.getElementById("status"),
  ledger: document.getElementById("ledger"),
  bell: null, // created by setupBell() below
  indexMeta: document.getElementById("index-meta"),
};

/* ── The bell ─────────────────────────────────────────────── */
/* Fully self-contained: builds its own button and graphic, so it
   works with any version of index.html. The sound is a synthesized
   brass counter bell — metallic strike + shimmering ring — via the
   Web Audio API. No sound files. */

let audioCtx = null;

function ensureAudio() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

// Browsers block sound until the page gets a user gesture; unlock on the
// very first tap/click/keypress anywhere so later dings always play.
for (const evt of ["pointerdown", "keydown", "touchstart"]) {
  window.addEventListener(evt, ensureAudio, { once: true, passive: true });
}

function ringBell({ soft = false } = {}) {
  const ctx = ensureAudio();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = soft ? 0.16 : 0.4;
    master.connect(ctx.destination);

    // 1) The strike — a sharp metallic "tick" (filtered noise burst).
    const noiseLen = 0.03;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * noiseLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2500;
    const strikeGain = ctx.createGain();
    strikeGain.gain.setValueAtTime(0.7, now);
    strikeGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
    noise.connect(hp).connect(strikeGain).connect(master);
    noise.start(now);

    // 2) The ring — inharmonic brass partials. Each partial is a detuned
    //    pair, which beats slightly and gives the real-bell shimmer.
    const partials = [
      { freq: 1479, gain: 1.0,  decay: 2.4 },
      { freq: 2093, gain: 0.5,  decay: 1.7 },
      { freq: 2794, gain: 0.32, decay: 1.1 },
      { freq: 3729, gain: 0.18, decay: 0.6 },
      { freq: 4699, gain: 0.08, decay: 0.35 },
    ];

    for (const p of partials) {
      for (const cents of [-5, 5]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = p.freq;
        osc.detune.value = cents;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(p.gain / 2, now + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + p.decay);
        osc.connect(gain).connect(master);
        osc.start(now);
        osc.stop(now + p.decay + 0.05);
      }
    }
  } catch {
    /* audio unavailable — the bell stays decorative */
  }
}

// A proper counter bell: domed top, plunger button, round base.
const BELL_SVG = `
  <svg class="bell" viewBox="0 0 40 34" width="30" height="26" aria-hidden="true">
    <g class="bell-plunger">
      <rect x="18" y="3" width="4" height="6" rx="1.4" fill="var(--brass)"/>
      <rect x="15.5" y="1" width="9" height="3.4" rx="1.7" fill="var(--brass)"/>
    </g>
    <g class="bell-dome">
      <path d="M20 7 C10.5 7 4.5 14 3.5 23 L36.5 23 C35.5 14 29.5 7 20 7 Z" fill="var(--brass)"/>
      <path d="M20 7 C13.5 7 8.8 11.5 6.8 17 C11 12.5 15.5 10.4 20.5 10.2 C17 9.2 16 8 20 7 Z" fill="#c7a45c" opacity="0.85"/>
    </g>
    <rect x="1" y="24.5" width="38" height="4.5" rx="2.2" fill="var(--spruce)"/>
    <rect x="6" y="29" width="28" height="3" rx="1.5" fill="var(--spruce)" opacity="0.55"/>
  </svg>`;

function setupBell() {
  // Find whatever bell markup this page has and rebuild it in place.
  const old = document.getElementById("bell") || document.querySelector(".bell");
  if (!old) return null;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "bell-button";
  button.id = "bell-button";
  button.title = "Ring for service";
  button.setAttribute("aria-label", "Ring the bell and ask a question");
  button.innerHTML = BELL_SVG;

  // If the old bell was already wrapped in a button, replace the wrapper;
  // otherwise replace the bare SVG.
  const target = old.closest("#bell-button, .bell-button") || old;
  target.replaceWith(button);

  button.addEventListener("click", () => {
    ringBell();
    shakeBell();
    if (els.question) {
      els.question.focus();
      els.question.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
  return button.querySelector(".bell");
}

function shakeBell() {
  if (!els.bell) return;
  els.bell?.classList.add("ringing");
  setTimeout(() => {
    if (!busy) els.bell?.classList.remove("ringing");
  }, 900);
}

els.bell = setupBell();

/* ── Branding ─────────────────────────────────────────────── */

els.orgName.textContent = CONFIG.orgName || "";
els.tagline.textContent = CONFIG.tagline || "How can we help?";
els.subtitle.textContent = CONFIG.subtitle || "";
document.title = `Front Desk — ${CONFIG.orgName || "Ask us anything"}`;

for (const suggestion of CONFIG.suggestions || []) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = suggestion;
  chip.addEventListener("click", () => {
    els.question.value = suggestion;
    els.form.requestSubmit();
  });
  els.chips.appendChild(chip);
}

/* ── Index & embedding model ──────────────────────────────── */

let index = null;
let indexPromise = null;
let embedder = null;
let embedderPromise = null;

function setStatus(text) {
  els.status.textContent = text;
}

async function loadIndex() {
  if (index) return index;
  indexPromise ??= (async () => {
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("Couldn't load index.json — has the deploy workflow run yet?");
    index = await res.json();
    const when = index.generated ? new Date(index.generated).toLocaleDateString() : "unknown";
    els.indexMeta.textContent = `${index.documentCount} document(s) · ${index.chunks.length} passages · indexed ${when}`;
    return index;
  })();
  return indexPromise;
}

async function loadEmbedder() {
  if (embedder) return embedder;
  embedderPromise ??= (async () => {
    setStatus("Warming up the desk — loading the search model (first visit only, ~25 MB)…");
    const idx = await loadIndex();
    const { pipeline, env } = await import(
      "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2"
    );
    env.allowLocalModels = false;
    embedder = await pipeline("feature-extraction", idx.model || "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
    setStatus("");
    return embedder;
  })();
  return embedderPromise;
}

// Warm both in the background so the first question feels instant.
loadIndex().catch((err) => setStatus(err.message));
if ("requestIdleCallback" in window) {
  requestIdleCallback(() => loadEmbedder().catch(() => {}));
} else {
  setTimeout(() => loadEmbedder().catch(() => {}), 1500);
}

/* ── Retrieval ────────────────────────────────────────────── */

async function retrieve(question, scope = "auto") {
  const idx = await loadIndex();
  const scopedChunks = filterChunksByScope(idx.chunks, scope);
  const hubDirectory = buildStructuredHubDirectoryAnswer(scopedChunks, question);
  if (hubDirectory) {
    return {
      results: hubDirectory.chunks.map((chunk) => ({
        chunk,
        cosine: 1,
        exactCodeMatch: false,
        structuredListMatch: true,
        score: 1,
      })),
      query: null,
      codeTerms: [],
      structuredAnswer: hubDirectory.answer,
      structuredNote: "Complete result from every matching row in Hubverse's verified directory table.",
    };
  }
  const structuredList = buildStructuredCodeListAnswer(scopedChunks, question);
  if (structuredList) {
    const results = structuredList.chunks.slice(0, TOP_K).map((chunk) => ({
      chunk,
      cosine: 1,
      exactCodeMatch: false,
      structuredListMatch: true,
      score: 1,
    }));
    return {
      results,
      query: null,
      codeTerms: [],
      structuredAnswer: structuredList.answer,
      structuredNote: "Complete code list from every matching workbook row.",
    };
  }

  await loadEmbedder();
  const embeddingQuestion = `${idx.queryPrefix || ""}${question}`;
  const output = await embedder(embeddingQuestion, { pooling: "mean", normalize: true });
  const query = Array.from(output.data);
  const { results, codeTerms } = rankChunks(scopedChunks, query, question, {
    topK: TOP_K,
    minScore: MIN_SCORE,
  });
  return { results, query, codeTerms, structuredAnswer: null, structuredNote: null };
}

/**
 * Free-mode answer composition: find the best CONTIGUOUS run of sentences
 * within a single retrieved passage — never stitched across documents,
 * which produces incoherent mixed answers. Table rows are kept whole.
 */
async function composeExtractiveAnswer(queryVec, results) {
  // Split each top chunk into ordered units (sentences, or whole table rows).
  const perChunk = [];
  for (const r of results.slice(0, 4)) {
    const units = [];
    for (const line of r.chunk.text.split(/\n+/)) {
      const t = line.trim();
      if (!t) continue;
      const isTableRow = (t.match(/\|/g) || []).length >= 2 || t.split(",").length >= 4;
      if (isTableRow) {
        units.push({ text: t, row: true }); // table/CSV row — keep intact
      } else {
        for (const sPart of t.split(/(?<=[.!?])\s+/)) {
          const c = sPart.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*•]\s*/, "");
          if (c.length >= 25 && c.length <= 500) units.push({ text: c, row: false });
        }
      }
    }
    if (units.length) perChunk.push({ r, units: units.slice(0, 28) });
  }
  if (!perChunk.length) return results[0].chunk.text;

  // Score every unit against the question (one batched embedding call).
  const flat = perChunk.flatMap((p) => p.units.map((u) => u.text)).slice(0, 100);
  const output = await embedder(flat, { pooling: "mean", normalize: true });
  const dims = output.dims[1];
  let cursor = 0;
  for (const p of perChunk) {
    for (const u of p.units) {
      if (cursor >= flat.length) { u.score = 0; continue; }
      let score = 0;
      for (let k = 0; k < dims; k++) score += queryVec[k] * output.data[cursor * dims + k];
      u.score = score;
      cursor++;
    }
  }

  // Best contiguous window (1–5 units, ≤700 chars) within any single chunk.
  let best = null;
  for (const p of perChunk) {
    for (let i = 0; i < p.units.length; i++) {
      let chars = 0;
      let sum = 0;
      for (let j = i; j < Math.min(i + 5, p.units.length); j++) {
        chars += p.units[j].text.length;
        if (chars > 700 && j > i) break;
        sum += p.units[j].score;
        const count = j - i + 1;
        const windowScore = sum / count + 0.02 * count + 0.1 * p.r.cosine;
        if (!best || windowScore > best.score) {
          best = { score: windowScore, mean: sum / count, result: p.r, units: p.units.slice(i, j + 1) };
        }
      }
    }
  }

  if (!best || best.mean < MIN_SCORE) return results[0].chunk.text;
  const hasRows = best.units.some((u) => u.row);
  if (hasRows) {
    const formatted = formatStructuredRows(
      best.units.map((unit) => ({ line: unit.text, sheet: best.result.chunk.sheet || "" })),
      { maxRecords: 8 },
    );
    if (formatted) return formatted;
  }
  return best.units.map((u) => u.text).join(hasRows ? "\n" : " ");
}

/* ── Rendering ────────────────────────────────────────────── */

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function sourceUrl(idx, chunk) {
  if (chunk.link) return chunk.link; // websites & external repos carry their own URL
  if (/^https?:\/\//i.test(chunk.source)) return chunk.source;
  if (!idx.repo) return null;
  return `https://github.com/${idx.repo}/blob/${idx.branch || "main"}/${chunk.source}`;
}

function addFeedback(entry, question, answer, scope = "auto") {
  const idx = index;
  if (!idx || !idx.repo) return;
  const row = document.createElement("p");
  row.className = "feedback-row";
  const title = encodeURIComponent(`[Front Desk feedback] ${question.slice(0, 80)}`);
  const body = encodeURIComponent(
    `**Question asked:**\n${question}\n\n**Search scope:** ${scope}\n\n**Answer shown:**\n${answer.slice(0, 1000)}\n\n**What was wrong or missing:**\n(please describe)`
  );
  row.innerHTML = `Not right? <a href="https://github.com/${idx.repo}/issues/new?title=${title}&body=${body}" target="_blank" rel="noopener">Report this answer</a>.`;
  entry.appendChild(row);
}

function renderEntry(question) {
  const entry = document.createElement("article");
  entry.className = "entry";
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  entry.innerHTML = `
    <h2 class="entry-question">${escapeHtml(question)}</h2>
    <span class="entry-time">Asked at ${time}</span>
    <p class="entry-answer">Looking that up…</p>
  `;
  els.ledger.replaceChildren(entry); // only the current question is shown
  return entry;
}

function renderSources(entry, idx, results) {
  const label = document.createElement("p");
  label.className = "sources-label";
  label.textContent = "Sources";
  entry.appendChild(label);
  const wrap = document.createElement("div");
  wrap.className = "sources";
  // Show each source file once, at its best-scoring passage.
  const seen = new Map();
  for (const r of results) {
    if (!seen.has(r.chunk.source)) seen.set(r.chunk.source, r);
  }
  for (const r of seen.values()) {
    const url = sourceUrl(idx, r.chunk);
    const card = document.createElement(url ? "a" : "div");
    card.className = "source-card";
    if (url) {
      card.href = url;
      card.target = "_blank";
      card.rel = "noopener";
    }
    card.innerHTML = `
      <p class="source-title">${escapeHtml(r.chunk.title)}</p>
      <p class="source-path">${escapeHtml(r.chunk.source)}</p>
      ${r.chunk.location ? `<p class="source-location">Location: ${escapeHtml(r.chunk.location)}</p>` : ""}
      <p class="source-snippet">${escapeHtml(r.chunk.text.slice(0, 220))}</p>
      <p class="source-score">${r.chunk.kind === "hub-directory"
        ? `Verified structured source${r.chunk.sourceUpdated ? ` · updated ${escapeHtml(r.chunk.sourceUpdated)}` : ""}`
        : r.bm25 > 0
          ? "Hybrid semantic + exact-word match"
          : `${Math.round(Math.max(0, Math.min(1, r.cosine)) * 100)}% semantic match`}</p>
    `;
    wrap.appendChild(card);
  }
  entry.appendChild(wrap);
}

/* ── Ask flow ─────────────────────────────────────────────── */

let busy = false;

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = els.question.value.trim();
  const scope = els.sourceScope?.value || "auto";
  if (!question || busy) return;

  busy = true;
  els.askButton.disabled = true;
  els.bell?.classList.add("ringing");
  els.question.value = "";

  // Creating/resuming the audio context during this click/submit gesture
  // lets the soft "answer ready" ding play later without being blocked.
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio — fine */ }

  const entry = renderEntry(question);
  const answerEl = entry.querySelector(".entry-answer");

  try {
    const { results, query, codeTerms, structuredAnswer, structuredNote } = await retrieve(question, scope);
    const idx = await loadIndex();

    const confidence = results.length ? results[0].cosine : 0;

    const hasExactCodeMatch = results.some((result) => result.exactCodeMatch);
    if (!isConfidentResult(results[0])) {
      answerEl.className = "entry-answer empty-result";
      answerEl.textContent =
        "I don't have a confident answer for that in our files — rather than guess, I'll say so. Try rephrasing, or this topic may need to be added to the knowledge folder.";
      if (results.length > 0) {
        const note = document.createElement("p");
        note.className = "entry-note";
        note.textContent = "The closest material I found is below, in case it helps:";
        entry.appendChild(note);
        renderSources(entry, idx, results);
      }
      addFeedback(entry, question, "(no confident answer)", scope);
      return;
    }

    if (structuredAnswer) {
      answerEl.textContent = structuredAnswer;
      const note = document.createElement("p");
      note.className = "entry-note";
      note.textContent = `${structuredNote} Source and exact location are below.`;
      entry.appendChild(note);
    } else {
      answerEl.textContent = "Selecting the best supported passage…";
      answerEl.textContent = formatExactCodeResults(results, codeTerms)
        || await composeExtractiveAnswer(query, results);
      const note = document.createElement("p");
      note.className = "entry-note";
      note.textContent = "Quoted or formatted from the most relevant indexed material; source and location are below.";
      entry.appendChild(note);
    }

    if (!hasExactCodeMatch && confidence < 0.45 && (results[0].lexicalCoverage || 0) < 0.7) {
      const caution = document.createElement("p");
      caution.className = "entry-note";
      caution.textContent = "Heads up: this match wasn't strong, so double-check against the sources below.";
      entry.appendChild(caution);
    }

    renderSources(entry, idx, results);
    addFeedback(entry, question, answerEl.textContent, scope);
    ringBell({ soft: true }); // answer's ready — a gentle ding
  } catch (err) {
    answerEl.className = "entry-answer empty-result";
    answerEl.textContent = `Something went wrong: ${err.message}`;
  } finally {
    busy = false;
    els.askButton.disabled = false;
    els.bell?.classList.remove("ringing");
    setStatus("");
  }
});
