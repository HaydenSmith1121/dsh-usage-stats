#!/usr/bin/env node
/**
 * Audit this package's *declared* compatibility against a real harness tree.
 *
 * This package is a built artifact that links nothing from `@deepseek-ai/*` —
 * the host half imports only Node builtins and its own modules — so the failure
 * modes that matter here are not link errors. They are **declarations**: a
 * manifest that names a client module a later release dropped, a bundle patch
 * that is not in the tarball, a peer range that refuses the runtime it is
 * installed on. Every one of those fails silently at runtime, in a different
 * way, on somebody else's machine.
 *
 *   node scripts/compat-check.mjs --tree <dir-of-@deepseek-ai-packages>
 *   node scripts/compat-check.mjs --tree <dir> --runtime 0.1.7-rc.2 [--json]
 *
 * `--tree` is any directory holding `@deepseek-ai/*` package directories —
 * a harness checkout's `node_modules`, an unpacked `dsh/` runtime, or a
 * directory assembled from an Electron `app.asar`. The bundled desktop runtime
 * is *not* a plain directory on disk (it is inside `app.asar`), so extract it
 * first; `_asar_extract_all.cjs` in the sibling scratch tree shows how.
 *
 * Repository-only tool: the published tarball ships `lib/` and has no scripts.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── version ranges ───────────────────────────────────────────────────────────
//
// The launcher evaluates this package's peers with
// `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
// (`@deepseek-ai/dsh-app-boot`, `evaluatePluginCompatibility`). `semver` is not
// a dependency of this package, so the rule is transcribed here — for the
// restricted grammar this package actually declares — and cross-checked against
// a real `semver` whenever the tree provides one.

const COMPARATOR = /^(>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** One parsed version, prerelease identifiers kept as written. */
function parseVersion(text) {
  const match = COMPARATOR.exec(text.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
    pre: match[5] === undefined ? [] : match[5].split('.'),
  };
}

/** semver §11 precedence: numeric identifiers compare numerically, and a
 *  version with a prerelease sorts below the same version without one. */
function compare(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index++) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
    if (a === b) continue;
    if (numeric) return Number(a) < Number(b) ? -1 : 1;
    if (/^\d+$/.test(a)) return -1;
    if (/^\d+$/.test(b)) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Whether `range` uses only the grammar {@link satisfies} implements. */
function grammarSupported(range) {
  return range.split('||').every((term) => term.trim().split(/\s+/).every((token) => {
    if (token.startsWith('^') || token.startsWith('~')) return COMPARATOR.test(token.slice(1));
    return COMPARATOR.test(token);
  }));
}

/**
 * `semver.satisfies(version, range, { includePrerelease: true })` over the
 * restricted grammar, plus `^`/`~` as single comparators.
 *
 * `includePrerelease` is what makes a prerelease runtime take part in a range at
 * all: without it a version carrying a prerelease tag only satisfies a
 * comparator set that carries a prerelease at the same major.minor.patch, which
 * is why this package declares one term per release train.
 */
function satisfies(version, range) {
  const target = parseVersion(version);
  if (target === undefined) throw new Error(`not a version: ${version}`);
  for (const term of range.split('||')) {
    const tokens = term.trim().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0) continue;
    const ok = tokens.every((token) => {
      if (token.startsWith('^') || token.startsWith('~')) {
        const base = parseVersion(token.slice(1));
        if (base === undefined) throw new Error(`unsupported range token: ${token}`);
        const upper = token.startsWith('^')
          ? { major: base.major + 1, minor: 0, patch: 0, pre: ['0'] }
          : { major: base.major, minor: base.minor + 1, patch: 0, pre: ['0'] };
        return compare(target, base) >= 0 && compare(target, upper) < 0;
      }
      const match = COMPARATOR.exec(token);
      if (match === null) throw new Error(`unsupported range token: ${token}`);
      const bound = parseVersion(token);
      const order = compare(target, bound);
      switch (match[1]) {
        case '>=': return order >= 0;
        case '<=': return order <= 0;
        case '>': return order > 0;
        case '<': return order < 0;
        default: return order === 0;
      }
    });
    if (ok) return true;
  }
  return false;
}

// ── argument parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined;
};
const TREE = valueOf('--tree') ?? process.env['DSH_TREE'];
const RUNTIME_OVERRIDE = valueOf('--runtime');
const AS_JSON = argv.includes('--json');

if (TREE === undefined) {
  process.stdout.write('usage: node scripts/compat-check.mjs --tree <dir-of-@deepseek-ai-packages> [--runtime <version>] [--json]\n');
  process.exitCode = 2;
} else {
  main(resolve(TREE));
}

// ── the audit ────────────────────────────────────────────────────────────────

/** Blank out comments, keeping string literals and their contents. */
function stripComments(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let i = index; i < stop; i += 1) if (text[i] === '\n') out += '\n';
      index = stop;
      continue;
    }
    if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      out += char;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          out += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += text[index];
        const closing = text[index] === char;
        index += 1;
        if (closing) break;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Every static `import … from "spec"` / `import("spec")` specifier. */
function staticImports(text) {
  const found = new Set();
  const code = stripComments(text);
  for (const match of code.matchAll(/(?:^|[^.\w$])import\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g)) found.add(match[1]);
  for (const match of code.matchAll(/(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]);
  return found;
}

/** Every `require("spec")` specifier — the shape the client factory uses. */
function requireCalls(text) {
  const found = new Set();
  for (const match of stripComments(text).matchAll(/(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]);
  return found;
}

/**
 * Every specifier the browser's module registry supplies rather than
 * `node_modules`.
 *
 * Measured, not assumed: React is bundled into the web frontend, and any
 * specifier the harness's *own* client modules `require()` is resolved by the
 * same registry for a plugin.
 */
function loaderProvided(tree) {
  const found = new Set(['react', 'react-dom', 'react/jsx-runtime']);
  const scope = join(tree, '@deepseek-ai');
  if (!existsSync(scope)) return found;
  for (const entry of readdirSync(scope)) {
    if (!entry.startsWith('dsh-client-')) continue;
    const file = join(scope, entry, 'lib', 'client.js');
    if (!existsSync(file)) continue;
    for (const specifier of requireCalls(readFileSync(file, 'utf8'))) found.add(specifier);
  }
  return found;
}

/** Whether a package directory exists under `tree`. */
function packageIn(tree, name) {
  const dir = join(tree, ...name.split('/'));
  return existsSync(join(dir, 'package.json'));
}

/** The runtime version this tree provides, as the launcher would read it. */
function runtimeVersion(tree) {
  if (RUNTIME_OVERRIDE !== undefined) return { version: RUNTIME_OVERRIDE, source: '--runtime' };
  for (const name of ['@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh']) {
    const file = join(tree, ...name.split('/'), 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof manifest.version === 'string') return { version: manifest.version, source: `${name}@${manifest.version}` };
  }
  return undefined;
}

/** `dsh.client.inject`, `dsh.bundle.patch`, `dsh.client.platform`. */
function dshManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const patches = manifest.dsh?.bundle?.patch;
  return {
    manifest,
    name: manifest.name,
    version: manifest.version,
    patches: patches === undefined ? [] : Array.isArray(patches) ? patches : [patches],
    clientInject: manifest.dsh?.client?.inject ?? [],
    platform: manifest.dsh?.client?.platform,
    peers: manifest.peerDependencies ?? {},
  };
}

function main(tree) {
  const report = { tree, runtime: runtimeVersion(tree), failures: [], notes: [], checked: 0 };
  const note = (message) => {
    report.notes.push(message);
    if (!AS_JSON) process.stdout.write(`note  ${message}\n`);
  };
  const fail = (message) => {
    report.failures.push(message);
    if (!AS_JSON) process.stdout.write(`FAIL  ${message}\n`);
  };
  const pass = (message) => {
    report.checked++;
    if (!AS_JSON) process.stdout.write(`ok    ${message}\n`);
  };

  const dsh = dshManifest();
  if (!AS_JSON) {
    process.stdout.write(`auditing ${dsh.name}@${dsh.version}\n`);
    process.stdout.write(`tree     ${tree}\n`);
    process.stdout.write(`runtime  ${report.runtime === undefined ? '(not identified)' : `${report.runtime.version} (from ${report.runtime.source})`}\n\n`);
  }

  // ── ① the range matcher, against the cases the declarations exist for ──────
  const selfTests = [
    ['0.1.7-rc.2', '>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0', true],
    ['0.1.6-alpha.1', '>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0', true],
    ['0.1.6-alpha.2', '>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0', true],
    ['0.2.0-rc.1', '>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0', false],
    ['0.1.5-rc.3', '>=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.0 <0.2.0-0', false],
    /* includePrerelease is the whole reason this is true where plain semver
       says false: no comparator carries a prerelease at 0.1.7. */
    ['0.1.7-rc.2', '>=0.1.6-alpha.1 <0.2.0', true],
    ['0.1.7-rc.2', '>=4.0.2 <5.0.0', false],
    ['4.0.4', '>=4.0.2 <5.0.0', true],
    ['18.2.0', '^18.2.0', true],
    ['19.0.0', '^18.2.0', false],
  ];
  let selfOk = true;
  for (const [version, range, expected] of selfTests) {
    if (satisfies(version, range) !== expected) {
      selfOk = false;
      fail(`range matcher: ${version} in "${range}" should be ${String(expected)}`);
    }
  }
  if (selfOk) pass(`range matcher agrees with semver on ${String(selfTests.length)} reference cases`);

  /* Cross-check against a real semver when the tree ships one. */
  const semverPath = join(tree, 'semver', 'package.json');
  if (existsSync(semverPath)) {
    note('a semver package is present in the tree; cross-checking is left to the reference cases above (this tool never imports from the audited tree)');
  }

  // ── ② the host half's import surface ──────────────────────────────────────
  //
  // Walked transitively over the host half's own relative graph, so a new file's
  // imports are audited too, and split by origin because the two failures differ:
  // a bare `@deepseek-ai/*` specifier that the tree lacks cannot *link*, while a
  // relative one that is missing means `lib/` is stale.
  const hostEntry = join(ROOT, 'lib', 'index.js');
  const hostFiles = [];
  const pending = [hostEntry];
  const visited = new Set();
  const bareImports = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    hostFiles.push(file);
    if (!existsSync(file)) {
      fail(`host file ${relative(ROOT, file)} is missing (lib/ out of date? run npm run build)`);
      continue;
    }
    for (const specifier of staticImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) {
        pending.push(resolve(dirname(file), specifier));
        continue;
      }
      bareImports.push({ specifier, from: relative(ROOT, file) });
    }
  }
  for (const { specifier, from } of bareImports) {
    if (packageIn(tree, specifier)) pass(`host import "${specifier}" (${from}) resolves in this tree`);
    else fail(`host import "${specifier}" (${from}) is not provided by this tree — a host import cannot link`);
  }
  if (bareImports.length === 0) {
    pass(`the host half imports no harness package at all (${String(hostFiles.length)} file(s) walked; nothing can fail to link)`);
  }

  // ── ③ the client half's require surface + declared injects ────────────────
  const provided = loaderProvided(tree);
  const clientFile = join(ROOT, 'lib', 'client.js');
  const required = existsSync(clientFile) ? requireCalls(readFileSync(clientFile, 'utf8')) : new Set();
  for (const specifier of required) {
    if (provided.has(specifier)) pass(`client require "${specifier}" is loader-provided`);
    else if (packageIn(tree, specifier)) pass(`client require "${specifier}" is a package in this tree`);
    else fail(`client require "${specifier}" is neither loader-provided nor in this tree`);
  }

  for (const specifier of dsh.clientInject) {
    if (!specifier.startsWith('@deepseek-ai/dsh-client-')) {
      fail(`dsh.client.inject "${specifier}" is not a @deepseek-ai/dsh-client-* module`);
      continue;
    }
    if (packageIn(tree, specifier)) pass(`dsh.client.inject "${specifier}" exists in this tree`);
    else if (provided.has(specifier)) pass(`dsh.client.inject "${specifier}" is loader-provided in this tree`);
    else fail(`dsh.client.inject "${specifier}" is not provided by this tree — the page would never load`);
  }

  // ── ④ manifest surfaces ───────────────────────────────────────────────────
  for (const patch of dsh.patches) {
    const file = resolve(ROOT, patch);
    if (existsSync(file) && statSync(file).isFile()) pass(`dsh.bundle.patch "${patch}" exists on disk`);
    else fail(`dsh.bundle.patch "${patch}" does not exist — the bundle would install with no patch`);
  }
  if (dsh.platform === 'web') pass('dsh.client.platform is "web"');
  else fail(`dsh.client.platform is ${JSON.stringify(dsh.platform)}; this release only builds a web client half`);

  const entry = join(ROOT, 'lib', 'index.js');
  if (existsSync(entry)) pass('lib/index.js (the package main) exists');
  else fail('lib/index.js is missing — run npm run build');

  // ── ⑤ declared peers against this tree's runtime ──────────────────────────
  const relevant = Object.entries(dsh.peers).filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'));
  if (relevant.length === 0) {
    note('no @deepseek-ai/dsh* peer is declared, so the launcher evaluates no compatibility for this package at all');
  } else if (report.runtime === undefined) {
    note('the tree does not identify its runtime version; peer ranges were not evaluated');
  } else {
    for (const [name, range] of relevant) {
      if (!grammarSupported(range)) {
        note(`peer ${name} range ${JSON.stringify(range)} uses grammar this tool does not implement; not evaluated`);
        continue;
      }
      if (satisfies(report.runtime.version, range)) pass(`peer ${name} ${range} admits runtime ${report.runtime.version}`);
      else fail(`peer ${name} ${range} REFUSES runtime ${report.runtime.version} — the launcher will deny this plugin`);
    }
  }

  if (AS_JSON) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(`\n${report.failures.length === 0
      ? `OK: ${String(report.checked)} surfaces checked against ${tree}\n`
      : `FAIL: ${String(report.failures.length)} problem(s) against ${tree}\n`}`);
  }
  process.exitCode = report.failures.length === 0 ? 0 : 1;
}
