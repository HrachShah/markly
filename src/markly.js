#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USAGE = `markly — markdown link checker

Usage:
  markly <directory> [--timeout=<ms>] [--no-fetch] [--no-anchor-check] [--json]
  markly --help

Options:
  --timeout=<ms>      Per-link timeout in milliseconds (default: 5000)
  --no-fetch          Skip network requests; only report file-relative links
  --strict            Exit with code 1 when any link is broken, missing, or has a bad anchor
  --no-anchor-check   Skip validating #anchor fragments in local file links
  --json              Output a single JSON report on stdout
  --help              Show this message

Walks <directory> for .md files, extracts every link, and prints a per-file
report. File-relative links are resolved against the source file's directory
and checked for existence; when a link has a #fragment, the heading anchor
is verified against the target file's heading set (matching the slug
algorithm used by GitHub, GitLab, and most static site generators). http(s)
links are fetched with a per-link timeout and the HTTP status is recorded.
`;

function printHelp() {
  process.stdout.write(USAGE);
}

function parseArgs(argv) {
  const opts = {
    timeout: 5000,
    fetch: true,
    json: false,
    checkAnchors: true,
    dir: null,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--no-fetch") { opts.fetch = false; continue; }
    if (arg === "--no-anchor-check") { opts.checkAnchors = false; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg === "--strict") { opts.strict = true; continue; }
    if (arg.startsWith("--timeout=")) {
      const v = Number(arg.slice("--timeout=".length));
      if (Number.isFinite(v) && v > 0) opts.timeout = v;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (!opts.dir) opts.dir = resolve(arg);
  }
  return opts;
}

async function walk(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Matches [text](url), <url> autolinks, and bare http(s) URLs. Skips code
// fences and inline code via a simple pre-pass that strips them.
function extractLinks(markdown) {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const links = [];
  const seen = new Set();
  const push = (url, text) => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ text: text ?? url, url });
  };

  // 1) [text](url) — capture both the visible text and the href.
  const mdRe = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = mdRe.exec(stripped)) !== null) {
    push(m[2], m[1]);
  }

  // 2) Mask out the markdown-link spans we already captured so the bare-URL
  //    pass does not re-emit the same href as a separate "bare" entry. The
  //    mask preserves character positions (spaces, not \0) so the bare-URL
  //    regex's `(?:^|[\s>])` anchor still fires correctly. The character
  //    classes of the masked characters do not matter as long as they are
  //    not URL characters; we use a single space, which is excluded from
  //    both the markdown href and the bare-URL character class.
  const masked = stripped.replace(
    /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_full, href) => " ".repeat(_full.length - href.length) + " ".repeat(href.length),
  );

  // 3) <https://...> autolinks (CommonMark §6.5) and bare http(s) URLs.
  //    Trailing prose punctuation `.`, `,`, `;`, `:` is stripped: those
  //    characters are not valid URL characters per RFC 3986, so a trailing
  //    run of them is almost always the surrounding sentence punctuation
  //    (e.g. "see https://x.com.") rather than part of the link. `?` and
  //    `!` are NOT stripped: `?` is the query separator and a URL may
  //    legitimately end in `!` if the path itself does.
  const autoOrBare = /(?:^|[\s>])<?(https?:\/\/[^\s<>\)]+)>?/g;
  while ((m = autoOrBare.exec(masked)) !== null) {
    let url = m[1];
    const trailing = url.match(/[.,;:]+$/);
    if (trailing) url = url.slice(0, -trailing[0].length);
    if (!url) continue;
    push(url, url);
  }
  return links;
}

function classify(url) {
  if (/^https?:\/\//i.test(url)) return "remote";
  if (url.startsWith("mailto:") || url.startsWith("#")) return "skip";
  return "local";
}

// GitHub's heading-slug algorithm (matches github-slugger / CommonMark's
// widely-used variant). Lowercase, strip diacritics, drop everything that is
// not a word character / hyphen / space, then collapse whitespace to single
// hyphens. Trims leading and trailing hyphens so headings like "## - Edge
// Case -" and "##   Spaces   " slug to a stable form. We do NOT handle the
// duplicate-anchor disambiguation (`#install` vs `## Install ## Install`)
// here; the first occurrence wins and the rest are appended with `-1`,
// `-2`, ... by `buildAnchorSet`, mirroring the convention users see on
// GitHub, GitLab, and most static site generators.
function slugifyHeading(text) {
  const stripped = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\- ]/g, "")
    .trim()
    .replace(/ /g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return stripped;
}

// Extract the slug-anchor set for a markdown file. Headings in ATX (`#`)
// and Setext (`=====` / `-----`) form are both supported, as is the
// trailing-`#` stripping that CommonMark allows ("## Install ##" -> "Install").
// Code-fenced blocks are stripped first so a `### fake` inside a fenced
// example does not register as a real anchor — that mirrors how GitHub
// renders the file.
function buildAnchorSet(markdown) {
  // Fenced code blocks are stripped so a `### fake` inside a fenced
  // example does not register as a real anchor (mirrors how GitHub
  // renders the file). Inline code spans are unwrapped so the text
  // inside is preserved for slugging.
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`\n]+)`/g, "$1");

  const headings = [];
  // ATX: lines beginning with 1-6 '#' characters, optional trailing #'s.
  const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/gm;
  let m;
  while ((m = atx.exec(stripped)) !== null) {
    const text = m[2].trim();
    if (text) headings.push(text);
  }
  // Setext: a text line followed by a row of '=' or '-' of any length.
  const setext = /^(.+?)\n[=\-]{2,}\s*$/gm;
  while ((m = setext.exec(stripped)) !== null) {
    const text = m[1].trim();
    if (text) headings.push(text);
  }

  const seen = new Map(); // slug -> count
  const anchors = new Set();
  for (const h of headings) {
    const slug = slugifyHeading(h);
    if (!slug) continue;
    const count = seen.get(slug) || 0;
    if (count === 0) {
      anchors.add(slug);
    } else {
      anchors.add(`${slug}-${count}`);
    }
    seen.set(slug, count + 1);
  }
  return anchors;
}

const anchorCache = new Map(); // absPath -> { mtimeMs, anchors }

async function getAnchors(absPath) {
  let s;
  try {
    s = await stat(absPath);
  } catch {
    return null;
  }
  if (!s.isFile()) return null;
  const cached = anchorCache.get(absPath);
  if (cached && cached.mtimeMs === s.mtimeMs) return cached.anchors;
  const md = await readFile(absPath, "utf8");
  const anchors = buildAnchorSet(md);
  anchorCache.set(absPath, { mtimeMs: s.mtimeMs, anchors });
  return anchors;
}

async function checkLocal(url, sourceFile, opts) {
  const baseDir = dirname(sourceFile);
  const hashIdx = url.indexOf("#");
  const pathPart = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? "" : url.slice(hashIdx + 1);
  // `[section](#install)` (no path prefix) is an anchor-only link that
  // resolves to the source file itself.
  const isAnchorOnly = pathPart === "" || pathPart === "#";
  const abs = isAnchorOnly ? sourceFile : resolve(baseDir, pathPart || "./");
  let targetStat;
  try {
    targetStat = await stat(abs);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { status: "missing", kind: "local-file", detail: "file not found" };
    }
    return { status: "error", kind: "local-file", detail: String(err.message || err) };
  }
  if (targetStat.isDirectory()) {
    return { status: "ok", kind: "local-dir" };
  }
  if (!anchor) {
    return { status: "ok", kind: "local-file" };
  }
  if (opts && opts.checkAnchors === false) {
    return { status: "ok", kind: "local-file" };
  }
  const anchors = await getAnchors(abs);
  if (anchors === null) {
    return { status: "ok", kind: "local-file" };
  }
  if (anchors.has(anchor)) {
    return { status: "ok", kind: "local-file" };
  }
  return {
    status: "missing-anchor",
    kind: "local-file",
    detail: `no heading '#${anchor}' (or '${anchor}-N' for duplicates)`,
  };
}

async function checkRemote(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Some servers reject HEAD; fall back to a range GET once.
    if (res.status === 405 || res.status === 403) {
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), timeoutMs);
      try {
        const r2 = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: c2.signal,
          headers: { Range: "bytes=0-0" },
        });
        clearTimeout(t2);
        return { status: classifyHttpStatus(r2.status), kind: "remote", code: r2.status };
      } catch (err) {
        clearTimeout(t2);
        return { status: "error", kind: "remote", detail: err.message || String(err) };
      }
    }
    return { status: classifyHttpStatus(res.status), kind: "remote", code: res.status };
  } catch (err) {
    clearTimeout(timer);
    const detail = err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (err.message || String(err));
    return { status: "error", kind: "remote", detail };
  }
}

function classifyHttpStatus(code) {
  if (code >= 200 && code < 400) return "ok";
  if (code === 404 || code === 410) return "missing";
  return "broken";
}

function formatReport(report, asJson) {
  if (asJson) {
    return JSON.stringify(report, null, 2) + "\n";
  }
  const lines = [];
  let totalOk = 0, totalBroken = 0, totalMissing = 0, totalError = 0, totalSkip = 0, totalAnchor = 0;
  for (const file of report.files) {
    lines.push(relative(report.root, file.path) || file.path);
    if (file.links.length === 0) {
      lines.push("  (no links)");
      lines.push("");
      continue;
    }
    for (const link of file.links) {
      const tag =
        link.status === "ok" ? "OK  " :
        link.status === "missing" ? "MISS" :
        link.status === "missing-anchor" ? "ANCH" :
        link.status === "broken" ? "BRK " :
        link.status === "error" ? "ERR " : "SKIP";
      const code = link.code ? ` [${link.code}]` : "";
      const detail = link.detail ? ` — ${link.detail}` : "";
      lines.push(`  [${tag}] ${link.url}${code}${detail}`);
      if (link.status === "ok") totalOk++;
      else if (link.status === "missing") totalMissing++;
      else if (link.status === "missing-anchor") totalAnchor++;
      else if (link.status === "broken") totalBroken++;
      else if (link.status === "error") totalError++;
      else totalSkip++;
    }
    lines.push("");
  }
  lines.push(
    `Summary: ${report.files.length} file(s), ` +
    `${totalOk} ok, ${totalMissing} missing, ${totalAnchor} bad-anchor, ${totalBroken} broken, ` +
    `${totalError} error, ${totalSkip} skipped`
  );
  return lines.join("\n") + "\n";
}

async function run(opts) {
  if (!opts.dir) {
    process.stderr.write("error: directory required\n");
    process.stderr.write("Run `markly --help` for usage.\n");
    process.exit(2);
  }
  const rootStat = await stat(opts.dir);
  if (!rootStat.isDirectory()) {
    process.stderr.write(`error: ${opts.dir} is not a directory\n`);
    process.exit(2);
  }
  const files = await walk(opts.dir);
  const report = { root: opts.dir, files: [] };
  for (const f of files) {
    const md = await readFile(f, "utf8");
    const links = extractLinks(md);
    const checked = [];
    for (const link of links) {
      const kind = classify(link.url);
      if (kind === "skip") {
        checked.push({ ...link, status: "skip", kind });
        continue;
      }
      if (kind === "local") {
        checked.push({ ...link, ...(await checkLocal(link.url, f, opts)) });
        continue;
      }
      if (kind === "remote") {
        if (!opts.fetch) {
          checked.push({ ...link, status: "skip", kind, detail: "fetch disabled" });
          continue;
        }
        checked.push({ ...link, ...(await checkRemote(link.url, opts.timeout)) });
      }
    }
    report.files.push({ path: f, links: checked });
  }
  process.stdout.write(formatReport(report, opts.json));
  if (opts.strict) {
    let bad = 0;
    for (const f of report.files) {
      for (const link of f.links) {
        if (link.status !== "ok" && link.status !== "skip") bad++;
      }
    }
    if (bad > 0) process.exit(1);
  }
}

const argv = process.argv.slice(2);
const opts = parseArgs(argv);
if (opts.help) {
  printHelp();
  process.exit(0);
}
run(opts).catch((err) => {
  process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
