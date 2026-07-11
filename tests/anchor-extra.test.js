import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = new URL("../src/markly.js", import.meta.url).pathname;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("anchor fragments: existing ATX heading passes, missing anchor reports 'missing-anchor'", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-anchor-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(
    join(dir, "index.md"),
    "# Index\n\nReal heading: [install](sub/guide.md#install).\nMissing anchor: [bad](sub/guide.md#no-such-thing).\n",
  );
  writeFileSync(
    join(dir, "sub", "guide.md"),
    "# Title\n\n## Install\n\nSome text.\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json", "--strict"]);
    assert.equal(r.status, 1);
    const report = JSON.parse(r.stdout);
    const indexFile = report.files.find((f) => f.path.endsWith("index.md"));
    const linkByUrl = new Map(indexFile.links.map((l) => [l.url, l]));
    const install = linkByUrl.get("sub/guide.md#install");
    assert.ok(install, "expected sub/guide.md#install in report");
    assert.equal(install.status, "ok");
    const bad = linkByUrl.get("sub/guide.md#no-such-thing");
    assert.ok(bad, "expected sub/guide.md#no-such-thing in report");
    assert.equal(bad.status, "missing-anchor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anchor fragments: inline code text is included in the slug; fenced code blocks do not register as headings", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-anchor2-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "index.md"), "[x](sub/page.md#hello-world)\n");
  writeFileSync(
    join(dir, "sub", "page.md"),
    "## Hello `world`\n\n```\n### fake\n```\n\n## Real heading\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const indexFile = report.files.find((f) => f.path.endsWith("index.md"));
    const hello = indexFile.links[0];
    assert.equal(hello.status, "ok", "inline code slug should resolve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anchor fragments: --no-anchor-check suppresses the check", () => {
  const dir = mkdtempSync(join(tmpdir(), "markly-anchor3-"));
  writeFileSync(join(dir, "guide.md"), "# Something Else\n");
  writeFileSync(
    join(dir, "index.md"),
    "Anchor to nowhere: [x](guide.md#no-such-thing)\n",
  );
  try {
    const r = runCli([dir, "--no-fetch", "--no-anchor-check", "--json"]);
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout);
    const indexFile = report.files.find((f) => f.path.endsWith("index.md"));
    const link = indexFile.links[0];
    assert.equal(link.status, "ok", "link should be ok with --no-anchor-check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("anchor fragments: .#x and ./#x are treated as anchor-only and checked against the source file's own headings", () => {
  // Regression: previously `[ok](.#missing)` and `[ok](./page.md#missing)`
  // (where `./` and `.` appear before `#` and the path is otherwise empty)
  // resolved the path part to a directory and returned status: "ok"
  // without ever performing the heading lookup. The dot / dot-slash
  // forms are conventional shorthand for "this file", so they should
  // behave the same as `#x` (anchor-only) and the anchor should be
  // verified against the source file's own headings.
  const dir = mkdtempSync(join(tmpdir(), "markly-anchor4-"));
  writeFileSync(
    join(dir, "page.md"),
    [
      "# Real Heading",
      "",
      "Missing anchor with . prefix: [bad](.#no-such-thing)",
      "Missing anchor with ./ prefix: [bad](./#no-such-thing)",
    ].join("\n"),
  );
  try {
    const r = runCli([dir, "--no-fetch", "--json", "--strict"]);
    assert.equal(
      r.status,
      1,
      "expected strict failure on missing anchors; stdout=\n" + r.stdout,
    );
    const report = JSON.parse(r.stdout);
    const pageFile = report.files.find((f) => f.path.endsWith("page.md"));
    const byUrl = new Map(pageFile.links.map((l) => [l.url, l]));

    const dotBad = byUrl.get(".#no-such-thing");
    assert.ok(dotBad, "expected .#no-such-thing in report");
    assert.equal(
      dotBad.status,
      "missing-anchor",
      "'.' prefix should be treated as anchor-only, not a path",
    );

    const dotSlashBad = byUrl.get("./#no-such-thing");
    assert.ok(dotSlashBad, "expected ./#no-such-thing in report");
    assert.equal(
      dotSlashBad.status,
      "missing-anchor",
      "'./' prefix should be treated as anchor-only, not a path",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
