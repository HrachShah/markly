# markly

A small, zero-dependency markdown link checker for documentation sites.

`markly` walks a directory for `.md` files, extracts every link (including bare
URLs), and reports per-file health. File-relative links are resolved against
the source file's directory; `http(s)` links are fetched with a configurable
per-link timeout and the HTTP status is recorded.

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
markly <directory> [--timeout=<ms>] [--no-fetch] [--json]
markly --help
```

| Flag | Effect |
| --- | --- |
| `--timeout=<ms>` | Per-link timeout in milliseconds (default: 5000) |
| `--no-fetch` | Skip network requests; only check file-relative links |
| `--json` | Output a single JSON report on stdout |

### Example

```
docs/index.md
  [OK  ] nested/guide.md
  [MISS] nested/nope.md
docs/nested/guide.md
  [OK  ] ../../README.md
  [ERR ] https://example.invalid — timeout after 5000ms

Summary: 2 file(s), 2 ok, 1 missing, 0 broken, 1 error, 0 skipped
```

## What it checks

- **Local links** — `[text](relative/path.md)`, including `?query` and
  `#fragment` suffixes. The file is resolved relative to the source file's
  directory; missing files are reported as `MISS`.
- **Remote links** — `[text](https://...)` and bare `https://...` URLs. The
  checker issues a `HEAD` request and follows redirects; if the server rejects
  `HEAD` (some CDNs do), it falls back to a ranged `GET`. Status codes are
  classified: `200–399` are OK, `404`/`410` are missing, anything else is
  broken.
- **Skip** — `mailto:` links, pure fragment links (`#section`), and links
  inside fenced code blocks are skipped.

## Project layout

```
markly/
├── package.json
├── README.md
├── src/
│   └── markly.js       # the CLI
└── tests/
    └── markly.test.js  # node:test suite
```

## Running the tests

```bash
npm test
```

The tests spawn the CLI in subprocesses against temporary directory trees
and assert on stdout/stderr. No network access is required.

## License

MIT
