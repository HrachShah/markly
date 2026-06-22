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
test("resolves percent-encoded local links", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-encode-"));
  writeFileSync(join(dir, "src.md"), "See [home](hello%20world.md).\n");
  writeFileSync(join(dir, "hello world.md"), "# Hello\n");
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OK\s+\] hello%20world\.md/);
    assert.ok(!r.stdout.includes("MISS"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captures URLs with balanced parens in [text](url) form", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-paren-"));
  // Wikipedia-style URL with one level of balanced parens should be captured
  // whole, not truncated at the first `)`.
  writeFileSync(
    join(dir, "a.md"),
    "See [wikipedia](https://en.wikipedia.org/wiki/URL_(URI)).\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const links = report.files[0].links;
    // The link should include both opening and closing parens
    const wiki = links.find((l) => l.url && l.url.includes("wikipedia"));
    assert.ok(wiki, "expected wikipedia link to be extracted");
    assert.ok(
      wiki.url.endsWith("(URI))") || wiki.url.endsWith("(URI)"),
      `expected URL to include trailing closing paren, got: ${wiki.url}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts CommonMark <https://...> autolinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-auto-"));
  writeFileSync(
    join(dir, "a.md"),
    "Visit <https://example.com/page> today.\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const links = report.files[0].links;
    const autolink = links.find((l) => l.url === "https://example.com/page");
    assert.ok(autolink, "expected <https://example.com/page> to be extracted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips CommonMark title from inline local link URL", () => {
  // [text](path "title") is a valid CommonMark form. The title is
  // presentation-only — it must not be part of the URL passed to the
  // filesystem check. Before the fix, the regex captured the title inside
  // the URL, so `stat("page.md \"The home page\"")` returned ENOENT and a
  // real existing file was reported as missing.
  const dir = mkdtempSync(join(tmpdir(), "markly-title-"));
  writeFileSync(join(dir, "page.md"), "# Page\n");
  writeFileSync(
    join(dir, "index.md"),
    '[home](page.md "The home page")\n',
  );
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[OK {2}\] page\.md/);
    assert.ok(!r.stdout.includes("The home page"));
    assert.ok(!r.stdout.includes("MISS"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips single-quoted title from inline local link URL", () => {
  // CommonMark allows the title to be wrapped in '...' as well as "...".
  // The title-stripping pass must accept both forms. A link with a
  // single-quoted title and a missing target should be reported as MISS
  // with just the bare URL, not the URL+title.
  const dir = mkdtempSync(join(tmpdir(), "markly-title-sq-"));
  writeFileSync(
    join(dir, "index.md"),
    "[absent](nope.md 'A page that is not here')\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const link = report.files[0].links[0];
    assert.equal(link.url, "nope.md");
    assert.equal(link.status, "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strips title from inline remote link URL in JSON report", () => {
  // For a remote link, the title is never sent to the server — the URL we
  // hand to fetch() must be the bare URL or HEAD/GET goes to a path with
  // stray quote characters and the server returns 4xx.
  const dir = mkdtempSync(join(tmpdir(), "markly-title-remote-"));
  writeFileSync(
    join(dir, "index.md"),
    '[home](https://example.com/page "the title")\n',
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const link = report.files[0].links[0];
    assert.equal(link.url, "https://example.com/page");
    assert.equal(link.text, "home");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});