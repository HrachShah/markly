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

test("rejects non-numeric --timeout", () => {
  const r = runCli([".", "--timeout=abc", "--no-fetch"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--timeout must be a positive integer/);
});

test("rejects zero --timeout", () => {
  const r = runCli([".", "--timeout=0", "--no-fetch"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--timeout must be a positive integer/);
});

test("rejects negative --timeout", () => {
  const r = runCli([".", "--timeout=-5", "--no-fetch"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--timeout must be a positive integer/);
});

test("rejects --timeout larger than the 10-minute cap", () => {
  const r = runCli([".", "--timeout=999999999", "--no-fetch"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at most 600000/);
});

test("accepts --timeout at the 10-minute cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-cap-"));
  writeFileSync(join(dir, "index.md"), "# Index\n");
  try {
    const r = runCli([dir, "--timeout=600000", "--no-fetch"]);
    assert.equal(r.status, 0, `stderr was ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts URLs containing balanced parentheses", () => {
  // The old extractor split on the first ')' inside a URL, so a
  // Wikipedia-style link or a foo(bar) URL was truncated to the
  // first closing paren. The new parser balances parens, so the
  // whole URL survives.
  const dir = mkdtempSync(join(tmpdir(), "markly-paren-"));
  writeFileSync(
    join(dir, "with-parens.md"),
    [
      "# Links",
      "",
      "Wiki: [Node.js](https://en.wikipedia.org/wiki/Node.js_(software))",
      "",
      "Generic: [funky](https://example.com/foo(bar))",
      "",
      "Bare bare URL: <https://en.wikipedia.org/wiki/Node.js_(software)>",
      "",
      "Bare bare generic: <https://example.com/foo(bar)>",
      "",
    ].join("\n"),
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0, `stderr was ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    const file = report.files.find((f) => f.path.endsWith("with-parens.md"));
    assert.ok(file, "with-parens.md must be in the report");
    const urls = file.links.map((l) => l.url);
    assert.ok(
      urls.includes("https://en.wikipedia.org/wiki/Node.js_(software)"),
      `expected full wiki URL, got ${JSON.stringify(urls)}`,
    );
    assert.ok(
      urls.includes("https://example.com/foo(bar)"),
      `expected full foo(bar) URL, got ${JSON.stringify(urls)}`,
    );
    // No URL should be truncated mid-URL. The fixture intentionally
    // includes balanced parens inside the URL, so the URLs may
    // legitimately end with ')' (the closer). The previous extractor
    // would have produced `Node.js_(software` (truncated at the
    // first ')'), so check that no URL ends with the unterminated
    // form `_(software` or `foo(bar` (open paren with no closer).
    for (const u of urls) {
      assert.ok(
        !u.endsWith("_(software"),
        `URL was truncated at the inner paren: ${u}`,
      );
      assert.ok(
        !u.endsWith("/foo(bar"),
        `URL was truncated at the inner paren: ${u}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
