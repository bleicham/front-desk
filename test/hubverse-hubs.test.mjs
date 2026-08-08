import test from "node:test";
import assert from "node:assert/strict";
import { hubToIndexText, parseHubverseDirectoryHtml } from "../scripts/hubverse-hubs.mjs";
import { buildStructuredHubDirectoryAnswer } from "../site/retrieval.js";

const fixture = `
  <p>Stats are updated weekly every Monday. Last updated: 2026-08-03.</p>
  <table id="hubs-table">
    <thead><tr>
      <th>Hub</th><th>Organization</th><th>Category</th><th>Models</th>
      <th>Data Rows</th><th>Repo</th><th>S3 Bucket</th><th>Insights</th>
      <th>Forecasts</th><th>Evaluations</th>
    </tr></thead>
    <tbody>
      <tr><td>RSV Forecast Hub</td><td>CDC</td><td>Active</td><td>9</td><td>2,676,346</td><td><a href="https://github.com/CDCgov/rsv-forecast-hub">CDCgov/rsv-forecast-hub</a></td><td></td><td></td><td></td><td></td></tr>
      <tr><td>Private Flu Hub</td><td>WHO</td><td>Active</td><td></td><td></td><td>private</td><td></td><td></td><td></td><td></td></tr>
      <tr><td>Archive Hub</td><td>Hubverse</td><td>Archival</td><td>127</td><td>545,406,274</td><td><a href="https://github.com/hubverse-org/archive">hubverse-org/archive</a></td><td>✓</td><td></td><td></td><td></td></tr>
      <tr><td>Teaching Hub</td><td>University</td><td>Training</td><td>20</td><td>2,273,726</td><td><a href="https://github.com/example/teaching">example/teaching</a></td><td></td><td></td><td></td><td></td></tr>
    </tbody>
  </table>
  <p>4 hubs &nbsp;·&nbsp; 4 organizations &nbsp;·&nbsp; 156 models</p>
`;

function chunksFrom(directory) {
  return directory.hubs.map((hub) => ({
    kind: "hub-directory",
    source: "hubverse.io/community/hubs.html",
    link: directory.citation,
    title: hub.name,
    text: hubToIndexText(hub),
    hub,
    location: hub.location,
    sourceUpdated: directory.updated,
  }));
}

test("parses and validates the official Hubverse directory table shape", () => {
  const directory = parseHubverseDirectoryHtml(fixture);
  assert.equal(directory.hubs.length, 4);
  assert.equal(directory.updated, "2026-08-03");
  assert.equal(directory.hubs[0].repo, "CDCgov/rsv-forecast-hub");
  assert.equal(directory.hubs[0].dataRows, 2_676_346);
  assert.equal(directory.hubs[1].isPrivate, true);
  assert.equal(directory.hubs[0].location, "List of hubs table — row “RSV Forecast Hub”");
});

test("rejects an incomplete table instead of publishing a partial list", () => {
  assert.throws(
    () => parseHubverseDirectoryHtml(fixture.replace("4 hubs", "5 hubs")),
    /reports 5 hubs, but only 4 table rows were parsed/,
  );
});

test("lists every hub without a TOP_K limit and provides one exact citation", () => {
  const directory = parseHubverseDirectoryHtml(fixture);
  const result = buildStructuredHubDirectoryAnswer(chunksFrom(directory), "What hubs are available?");
  assert.equal(result.hubCount, 4);
  for (const hub of directory.hubs) assert.equal(result.answer.includes(hub.name), true);
  assert.equal(result.answer.includes("Active (2)"), true);
  assert.equal(result.answer.includes("Archival (1)"), true);
  assert.equal(result.chunks[0].location, "List of hubs table — all 4 rows");
});

test("filters structured directory questions without inventing matches", () => {
  const directory = parseHubverseDirectoryHtml(fixture);
  const result = buildStructuredHubDirectoryAnswer(chunksFrom(directory), "Which hubs have RSV?");
  assert.equal(result.hubCount, 1);
  assert.equal(result.answer.includes("RSV Forecast Hub"), true);
  assert.equal(result.answer.includes("Private Flu Hub"), false);
});
