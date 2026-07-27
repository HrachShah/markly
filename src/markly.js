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
      const value = arg.slice("--timeout=".length);
      const v = Number(value);
      if (!Number.isFinite(v) || v <= 0) {
        return { error: `invalid timeout: ${value}` };
      }
      opts.timeout = v;
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

// Matches [text](url), bare <url> autolinks, and bare http(s) URLs. Skips
// code fences and inline code via a simple pre-pass that strips them.
function extractLinks(markdown) {
  const stripped = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const links = [];
  const re = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    links.push({ text: m[0].slice(1, m[0].indexOf("]")), url: m[1] });
  }
  // CommonMark autolinks: <https://example.com>. The angle brackets are
  // significant (they disambiguate from a bare URL with no surrounding
  // markup), so we keep them distinct from the bare-URL pass below.
  const autolink = /<(https?:\/\/[^>\s]+)>/g;
  while ((m = autolink.exec(stripped)) !== null) {
    links.push({ text: m[1], url: m[1] });
  }
  const extractedUrls = new Set(links.map((link) => link.url));
  // Bare http(s) URLs not already inside a markdown link or autolink. The
  // lookbehind prevents double-counting the autolink URLs above, which the
  // engine still matches against the http:// prefix when re-evaluated by
  // this regex without it.
  const bare = /(?<![<"])(?:^|[\s>(\[])(https?:\/\/[^\s<>)"]+)/g;
  while ((m = bare.exec(stripped)) !== null) {
    // Strip a single trailing punctuation character (e.g. ".", ",", ")")
    // that is more likely sentence punctuation than part of the URL.
    const raw = m[1];
    const cleaned = raw.replace(/[.,;!?]+$/, "");
    if (!cleaned || extractedUrls.has(cleaned)) continue;
    links.push({ text: cleaned, url: cleaned });
  }
  return links;
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
    if (file.error) {
      lines.push(`  [ERR ] unable to read file — ${file.error}`);
      lines.push("");
      continue;
    }
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
  let rootStat;
  try {
    rootStat = await stat(opts.dir);
  } catch (err) {
    const detail = err && err.code === "ENOENT" ? "directory not found" : (err.message || String(err));
    process.stderr.write(`error: ${opts.dir} — ${detail}\n`);
    process.exit(2);
  }
  if (!rootStat.isDirectory()) {
    process.stderr.write(`error: ${opts.dir} is not a directory\n`);
    process.exit(2);
  }
  const files = await walk(opts.dir);
  const report = { root: opts.dir, files: [] };
  for (const f of files) {
    let md;
    try {
      md = await readFile(f, "utf8");
    } catch (err) {
      const detail = err && err.code === "EACCES" ? "permission denied" : (err.message || String(err));
      report.files.push({ path: f, links: [], error: detail });
      continue;
    }
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
if (opts.error) {
  process.stderr.write(`error: ${opts.error}\n`);
  process.stderr.write("Run `markly --help` for usage.\n");
  process.exit(2);
}
run(opts).catch((err) => {
  process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
