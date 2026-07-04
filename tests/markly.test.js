import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

test("does not loop on self-referencing symlink", () => {
  // walk() previously used isDirectory() on a Dirent, which is true for
  // symlinks pointing to directories, so a self-referencing symlink would
  // recurse forever. The fix tracks realpath() of every visited directory
  // and skips ones we have already seen. This test creates `root/sub` as a
  // symlink back to `root` and confirms the CLI still terminates and the
  // real files inside `root` are reported normally.
  const dir = mkdtempSync(join(tmpdir(), "markly-symlink-"));
  writeFileSync(join(dir, "index.md"), "# Root\n\n[home](README.md)\n");
  writeFileSync(join(dir, "README.md"), "# Home\n");
  // self-loop: dir/sub -> dir
  symlinkSync(dir, join(dir, "sub"), "dir");
  try {
    const r = runCli([dir, "--no-fetch"]);
    assert.equal(r.status, 0);
    // The real files should still be found and reported OK.
    assert.match(r.stdout, /OK.*README\.md/);
    // The CLI should have terminated rather than recursing forever.
    assert.ok(r.stdout.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("captures wikipedia-style URL with balanced parens", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-wiki-"));
  writeFileSync(
    join(dir, "wiki.md"),
    '# Wiki\n\n[Java](https://en.wikipedia.org/wiki/Java_(programming_language))\n'
  );
  writeFileSync(join(dir, "README.md"), "# Home\n");
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const wikiFile = report.files.find((f) => f.path.endsWith("wiki.md"));
    assert.ok(wikiFile);
    const javaLink = wikiFile.links.find((l) => l.url.includes("wikipedia.org"));
    assert.ok(javaLink, "wikipedia URL should be captured");
    assert.equal(
      javaLink.url,
      "https://en.wikipedia.org/wiki/Java_(programming_language)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects URL with unclosed paren instead of swallowing rest of line", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-unclosed-"));
  // The unclosed paren in "(broken" used to swallow the rest of the line
  // including the "and [real](README.md) ..." after it. With the fix, the
  // [bad](broken...) link is not reported and the real link still is.
  writeFileSync(
    join(dir, "broken.md"),
    "# Broken\n\n[bad](path(unclosed.md) and [real](README.md)\n"
  );
  writeFileSync(join(dir, "README.md"), "# Home\n");
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const file = report.files.find((f) => f.path.endsWith("broken.md"));
    assert.ok(file);
    const urls = file.links.map((l) => l.url);
    assert.equal(urls.length, 1, `expected 1 link, got: ${JSON.stringify(urls)}`);
    assert.equal(urls[0], "README.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parens in local file URLs are preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-local-paren-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  // GitHub-style relative paths sometimes include a branch ref like "(v1.0)".
  writeFileSync(
    join(dir, "docs", "index.md"),
    '# Index\n\n[release notes](release_(v1.0).md)\n'
  );
  writeFileSync(join(dir, "docs", "release_(v1.0).md"), "# Release\n");
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const file = report.files.find((f) => f.path.endsWith("index.md"));
    assert.ok(file);
    const link = file.links.find((l) => l.url.startsWith("release"));
    assert.ok(link, "link to release_(v1.0).md should be captured");
    assert.equal(link.url, "release_(v1.0).md");
    assert.equal(link.status, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two adjacent links each with parens are captured separately", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-adjacent-"));
  writeFileSync(
    join(dir, "two.md"),
    '# Two\n\n[one](foo(a).md) and [two](bar(b).md)\n'
  );
  writeFileSync(join(dir, "foo(a).md"), "# Foo\n");
  writeFileSync(join(dir, "bar(b).md"), "# Bar\n");
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const file = report.files.find((f) => f.path.endsWith("two.md"));
    assert.ok(file);
    const urls = file.links.map((l) => l.url);
    assert.deepEqual(urls, ["foo(a).md", "bar(b).md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
