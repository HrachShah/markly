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

test("preserves balanced parentheses inside URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-paren-"));
  const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
  writeFileSync(
    join(dir, "wiki.md"),
    `# Wiki\n\nSee [the Foo (bar) page](${url}).\n`,
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const wiki = report.files.find((f) => f.path.endsWith("wiki.md"));
    assert.ok(wiki, "wiki.md should appear in the report");
    const link = wiki.links.find((l) => l.url.startsWith("https://en.wikipedia.org"));
    assert.ok(link, "wikipedia link should be parsed");
    // The old regex truncated the URL to '...Foo_(bar' at the first ')',
    // so the closing ')' was dropped. The fix scans for the matching ')'
    // at depth 0, so the full URL with its trailing ')' round-trips.
    assert.ok(
      link.url.endsWith("Foo_(bar)"),
      `expected URL to end with 'Foo_(bar)' but got '${link.url}'`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
