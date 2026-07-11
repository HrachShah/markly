import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(HERE, "src", "markly.js");

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? HERE,
    timeout: 15000,
  });
}

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "markly-"));
  mkdirSync(join(root, "docs", "nested"), { recursive: true });
  writeFileSync(
    join(root, "docs", "index.md"),
    "# Index\n\nSee [guide](nested/guide.md) and [missing](nested/nope.md).\n",
  );
  writeFileSync(
    join(root, "docs", "nested", "guide.md"),
    "# Guide\n\n[home](../../README.md) and [external](https://example.com).\n",
  );
  writeFileSync(join(root, "README.md"), "# Root\n");
  return root;
}

test("--help prints usage and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /markdown link checker/);
  assert.match(r.stdout, /--timeout/);
});

test("scans directory and reports missing local link", () => {
  const dir = makeTree();
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nested\/guide\.md/);
    assert.match(r.stdout, /nested\/index\.md|nested\/nope\.md|MISS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("counts OK links for files that exist", () => {
  const dir = makeTree();
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[OK {2}\] nested\/guide\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json emits a parseable report", () => {
  const dir = makeTree();
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    assert.ok(Array.isArray(report.files));
    assert.ok(report.files.length >= 2);
    const guideFile = report.files.find((f) => f.path.endsWith("guide.md"));
    assert.ok(guideFile);
    const home = guideFile.links.find((l) => l.url.endsWith("README.md"));
    assert.ok(home);
    assert.equal(home.status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing directory argument exits non-zero", () => {
  const r = runCli([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /directory required/);
});

test("non-existent path exits non-zero", () => {
  const r = runCli(["/tmp/markly-no-such-dir-xyz"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fatal: Error/);
});

test("skips code-fenced links", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-fence-"));
  writeFileSync(
    join(dir, "fenced.md"),
    "# Title\n\n```\n[fake](definitely-not-a-real-link.md)\n```\n\nReal [home](README.md)\n",
  );
  writeFileSync(join(dir, "README.md"), "# Home\n");
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK/);
    // fenced link should not appear in output
    assert.ok(!r.stdout.includes("definitely-not-a-real-link.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("markdown-link and bare-URL forms of the same href are reported once", () => {
  // Regression: a URL written both as `[text](https://x.com)` and as a
  // bare `https://x.com` (very common in README prose: "see [the spec](
  // https://x.com/spec) for https://x.com/spec") used to be emitted twice,
  // so the remote probe hit the network twice and the report showed the
  // same target twice on the same file's row. The fix dedupes by URL.
  const dir = mkdtempSync(join(tmpdir(), "markly-dedupe-"));
  writeFileSync(
    join(dir, "index.md"),
    "see [the spec](https://example.com/spec) and also https://example.com/spec inline.\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const urls = report.files[0].links.map((l) => l.url);
    const matches = urls.filter((u) => u === "https://example.com/spec");
    assert.equal(matches.length, 1, `expected exactly one entry, got ${JSON.stringify(urls)}`);
    // The dedupe keeps the markdown-link entry (with visible text), not
    // the bare one, so the report can show the descriptive label.
    const entry = report.files[0].links.find((l) => l.url === "https://example.com/spec");
    assert.equal(entry.text, "the spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("angle-bracket autolinks <https://...> are recognized", () => {
  // CommonMark §6.5: <https://example.com> is a valid autolink. The
  // original extractor only handled the bare form, so the angle-bracket
  // variant was silently dropped from the report.
  const dir = mkdtempSync(join(tmpdir(), "markly-autolink-"));
  writeFileSync(
    join(dir, "index.md"),
    "go to <https://example.com/page> for details.\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const urls = report.files[0].links.map((l) => l.url);
    assert.ok(
      urls.includes("https://example.com/page"),
      `expected https://example.com/page, got ${JSON.stringify(urls)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare URL followed by sentence-ending punctuation is captured without the punctuation", () => {  // Regression: a bare URL written as "see https://example.com." (with
  // the period as end-of-sentence) used to be captured as
  // "https://example.com." which the remote probe then tried to fetch
  // as a host with a literal period glued to the end, producing
  // confusing DNS / TLS errors instead of the user's intended target.
  const dir = mkdtempSync(join(tmpdir(), "markly-bare-"));
  writeFileSync(
    join(dir, "index.md"),
    "# Title\n\nSee https://example.com. Also see https://other.com, and https://third.com; and https://fourth.com: the docs.\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const urls = report.files[0].links.map((l) => l.url);
    assert.ok(urls.includes("https://example.com"), `expected https://example.com, got ${JSON.stringify(urls)}`);
    assert.ok(urls.includes("https://other.com"), `expected https://other.com, got ${JSON.stringify(urls)}`);
    assert.ok(urls.includes("https://third.com"), `expected https://third.com, got ${JSON.stringify(urls)}`);
    assert.ok(urls.includes("https://fourth.com"), `expected https://fourth.com, got ${JSON.stringify(urls)}`);
    assert.ok(!urls.some((u) => /[.,;:]$/.test(u)), `no URL should retain trailing prose punctuation, got ${JSON.stringify(urls)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
