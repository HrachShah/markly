# markly

A small, zero-dependency markdown link checker for documentation sites.

`markly` walks a directory for `.md` files, extracts every link (including bare
URLs), and reports per-file health. File-relative links are resolved against
the source file's directory; `http(s)` links are fetched with a configurable
per-link timeout and the HTTP status is recorded. Fragment links
(`page.md#section`) are also validated against the target's headings.

## Why

Docs rot. Links move, pages get deleted, anchors shift. `markly` is a
single-file tool you can drop into CI to catch broken links before they ship.
It has no dependencies, runs on Node 18+, and emits either a human-readable
report or a JSON blob for piping into other tools.

## Install

```bash
npm install -g markly
# or run without installing
npx markly ./docs
```

## Usage

```bash
markly <directory> [--timeout=<ms>] [--no-fetch] [--no-anchor-check] [--json] [--strict]
markly --help
```

| Flag | Effect |
| --- | --- |
| `--timeout=<ms>` | Per-link timeout in milliseconds (default: 5000) |
| `--no-fetch` | Skip network requests; only check file-relative links |
| `--no-anchor-check` | Don't validate `#fragment` anchors in local file links |
| `--json` | Output a single JSON report on stdout |
| `--strict` | Exit non-zero when any link is not `ok` or `skip` |

### Example

```
docs/index.md
  [OK  ] nested/guide.md
  [OK  ] nested/guide.md#install
  [ANCH] nested/guide.md#removed-section — no heading '#removed-section' (or 'removed-section-N' for duplicates)
  [MISS] nested/nope.md
docs/nested/guide.md
  [OK  ] ../../README.md
  [ERR ] https://example.invalid — timeout after 5000ms

Summary: 2 file(s), 2 ok, 1 missing, 1 bad-anchor, 0 broken, 1 error, 0 skipped
```

## What it checks

- **Local links** — `[text](relative/path.md)`, including `?query` and
  `#fragment` suffixes. The file is resolved relative to the source file's
  directory; missing files are reported as `MISS`.
- **Anchor fragments** — when a local link has a `#fragment`, the target
  file's headings are extracted and the fragment is matched against
  GitHub-style heading slugs (lowercase, spaces and punctuation collapsed
  to hyphens, diacritics stripped, inline code unwrapped, fenced code
  blocks ignored). Duplicates are accepted as `name`, `name-1`, `name-2`,
  etc. Missing anchors are reported as `ANCH` / `bad-anchor`. Pass
  `--no-anchor-check` to disable. Pure fragment links (`#section`) and
  anchor-only links without a target file are skipped.
- **Remote links** — `[text](https://...)` and bare `https://...` URLs. The
  checker issues a `HEAD` request and follows redirects; if the server rejects
  `HEAD` (some CDNs do), it falls back to a ranged `GET`. Status codes are
  classified: `200–399` are OK, `404`/`410` are missing, anything else is
  broken.
- **Skip** — `mailto:` links, pure fragment links (`#section`), and links
  inside fenced code blocks are skipped.

## Exit codes

- `0` — every link is `ok` or `skip` (the default for human runs).
- `1` — at least one link is broken, missing, or has a bad anchor. Pass
  `--strict` to opt into this behavior; without it, the checker still
  prints every failure but exits 0 so you can review a long report
  without your CI screaming.

## Project layout

```
markly/
├── package.json
├── README.md
├── src/
│   └── markly.js       # the CLI
└── tests/
    ├── markly.test.js        # node:test suite
    └── anchor-extra.test.js  # tests for the #fragment checker
```

## Running the tests

```bash
npm test
```

The tests spawn the CLI in subprocesses against temporary directory trees
and assert on stdout/stderr. No network access is required.

## License

MIT
