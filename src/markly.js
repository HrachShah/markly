#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const USAGE = `markly — markdown link checker

Usage:
  markly <directory> [--timeout=<ms>] [--no-fetch] [--json]
  markly --help

Options:
  --timeout=<ms>  Per-link timeout in milliseconds (default: 5000)
  --no-fetch      Skip network requests; only report file-relative links
  --json          Output a single JSON report on stdout
  --help          Show this message

Walks <directory> for .md files, extracts every link, and prints a per-file
report. File-relative links are resolved against the source file's directory
and checked for existence. http(s) links are fetched with a per-link timeout
and the HTTP status is recorded.
`;

function printHelp() {
  process.stdout.write(USAGE);
}

function parseArgs(argv) {
  const opts = { timeout: 5000, fetch: true, json: false, dir: null };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--no-fetch") { opts.fetch = false; continue; }
    if (arg === "--json") { opts.json = true; continue; }
    if (arg.startsWith("--timeout=")) {
      const raw = arg.slice("--timeout=".length);
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) {
        process.stderr.write(`error: --timeout must be a positive integer (got ${JSON.stringify(raw)})\n`);
        process.exit(2);
      }
      const MAX_TIMEOUT_MS = 10 * 60 * 1000;
      if (v > MAX_TIMEOUT_MS) {
        process.stderr.write(`error: --timeout must be at most ${MAX_TIMEOUT_MS}ms (got ${v})\n`);
        process.exit(2);
      }
      opts.timeout = Math.floor(v);
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

// Matches [text](url) and bare <url> forms. Skips code fences and inline code
// via a simple pre-pass that strips them. The link-text -> link-url parser
// below walks the string char-by-char starting at the '(' so a URL that
// contains balanced parentheses (the CommonMark rule for unescaped parens in
// a link destination) is captured in full; a flat [^)\s]+ regex would stop
// at the first ')' and silently truncate URLs like
// https://en.wikipedia.org/wiki/Node.js_(software) to
// https://en.wikipedia.org/wiki/Node.js_(software.
function extractLinks(markdown) {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const links = [];
  // Inline link: [text](url) or [text](url "title").
  // Walk every '[' and try to parse a balanced-paren URL after the '('.
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== "[") continue;
    const textEnd = findClosingBracket(stripped, i);
    if (textEnd === -1) continue;
    let p = textEnd + 1;
    if (stripped[p] !== "(") continue;
    p++;
    const url = readBalancedUrl(stripped, p);
    if (url === null) continue;
    p = url.end;
    // Optional whitespace + "title" after the URL.
    while (p < stripped.length && (stripped[p] === " " || stripped[p] === "\t"))
      p++;
    if (p < stripped.length && stripped[p] === '"') {
      const titleEnd = findClosingQuote(stripped, p);
      if (titleEnd !== -1) p = titleEnd + 1;
    }
    if (p < stripped.length && stripped[p] === ")") {
      links.push({ text: stripped.slice(i + 1, textEnd), url: url.value });
      i = p;
    }
  }
  // Bare http(s) URLs in the text.
  const bare = /(?:^|[\s>])(https?:\/\/[^\s<>\)]+)/g;
  let m;
  while ((m = bare.exec(stripped)) !== null) {
    links.push({ text: m[1], url: m[1] });
  }
  return links;
}

// Find the next unescaped ']' starting from start (which must be '[').
// Returns the index of ']' or -1 if no close is found.
function findClosingBracket(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (s[i] === "]") return i;
  }
  return -1;
}

// Starting just after the '(', read a CommonMark link destination: a sequence
// of non-whitespace, non-control characters where '(' and ')' balance, and
// any backslash escapes the next character. Returns { value, end } where
// `value` is the URL (with escapes resolved) and `end` is the index of the
// matching ')'. Returns null if the URL is empty or has unbalanced parens.
function readBalancedUrl(s, start) {
  let i = start;
  let depth = 0;
  let out = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === "(") {
      depth++;
      out += c;
      i++;
      continue;
    }
    if (c === ")") {
      if (depth === 0) {
        if (out === "") return null;
        return { value: out, end: i };
      }
      depth--;
      out += c;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (out === "") return null;
      return { value: out, end: i };
    }
    out += c;
    i++;
  }
  return null;
}

// Find the next unescaped '"' starting at start (which must be '"').
function findClosingQuote(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

function classify(url) {
  if (/^https?:\/\//i.test(url)) return "remote";
  if (url.startsWith("mailto:") || url.startsWith("#")) return "skip";
  return "local";
}

async function checkLocal(url, sourceFile) {
  const baseDir = dirname(sourceFile);
  const stripped = url.split("#")[0].split("?")[0];
  if (!stripped) return { status: "ok", kind: "local-anchor" };
  const abs = resolve(baseDir, stripped);
  try {
    const s = await stat(abs);
    if (s.isDirectory()) return { status: "ok", kind: "local-dir" };
    return { status: "ok", kind: "local-file" };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { status: "missing", kind: "local-file", detail: "file not found" };
    }
    return { status: "error", kind: "local-file", detail: String(err.message || err) };
  }
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
  let totalOk = 0, totalBroken = 0, totalMissing = 0, totalError = 0, totalSkip = 0;
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
        link.status === "broken" ? "BRK " :
        link.status === "error" ? "ERR " : "SKIP";
      const code = link.code ? ` [${link.code}]` : "";
      const detail = link.detail ? ` — ${link.detail}` : "";
      lines.push(`  [${tag}] ${link.url}${code}${detail}`);
      if (link.status === "ok") totalOk++;
      else if (link.status === "missing") totalMissing++;
      else if (link.status === "broken") totalBroken++;
      else if (link.status === "error") totalError++;
      else totalSkip++;
    }
    lines.push("");
  }
  lines.push(
    `Summary: ${report.files.length} file(s), ` +
    `${totalOk} ok, ${totalMissing} missing, ${totalBroken} broken, ` +
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
        checked.push({ ...link, ...(await checkLocal(link.url, f)) });
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
