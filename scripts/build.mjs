/**
 * Build: `src/` → `lib/`.
 *
 *   node scripts/build.mjs            # write lib/
 *   node scripts/build.mjs --check    # fail if lib/ is not what src/ builds to
 *
 * There is no bundler and no transpiler here, on purpose. The host half is
 * plain ESM that Node can load directly, so building it is copying it. The
 * client half must be a single file inside DSH's `window.__ModuleLoader__`
 * envelope, so building it is: prepend the shared arithmetic (the only thing it
 * shares with the host) and add the three-line envelope.
 *
 * Consequences worth keeping:
 *   · the artifact is readable — `lib/usage/ledger.js` is the file you review;
 *   · the build is deterministic — same input bytes, same output bytes, which
 *     is what makes `--check` a meaningful CI gate;
 *   · nothing is downloaded at build time, so a build works offline.
 *
 * `lib/` **is** committed: this package is also installable straight from the
 * repository (`github:HaydenSmith1121/dsh-usage-stats`), and a git install runs
 * no build step of ours. `--check` is what keeps the committed copy honest.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC = join(REPO, 'src');
const LIB = join(REPO, 'lib');
const CHECK_ONLY = process.argv.includes('--check');

/** Copied verbatim; the import graph between them is relative and preserved. */
const HOST_FILES = [
  'index.js',
  'shared/buckets.js',
  'usage/decode.js',
  'usage/fold.js',
  'usage/ledger.js',
  'usage/scan.js',
  'usage/report.js',
  'usage/host.js',
];

const PACKAGE = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));

/** The envelope DSH's client-module carrier expects, byte for byte. */
function envelope(id, body) {
  return `window.__ModuleLoader__.load({ id: "${id}", factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n`
    + '"use strict";\n'
    + `${body}\n`
    + 'return module.exports; } });\n';
}

/** `export function f` → `function f`; the module body is inlined, not linked. */
function stripExports(text) {
  return text.replace(/^export\s+/gm, '');
}

/**
 * Refuse to emit a client body that still contains module syntax: the carrier
 * evaluates it as a function body, so a stray `import` would be a syntax error
 * in the browser and nowhere near the build.
 */
function assertNoModuleSyntax(body, label) {
  const offenders = [];
  for (const [index, line] of body.split('\n').entries()) {
    if (/^\s*(import|export)\s/.test(line)) offenders.push(`${label}:${String(index + 1)}: ${line.trim()}`);
  }
  if (offenders.length > 0) {
    throw new Error(`client body still contains module syntax:\n${offenders.join('\n')}`);
  }
}

/** Every artifact, as `relative path → text`. Pure; nothing is written here. */
async function renderOutputs() {
  const outputs = new Map();
  for (const rel of HOST_FILES) {
    outputs.set(rel, await readFile(join(SRC, rel), 'utf8'));
  }
  const shared = stripExports(await readFile(join(SRC, 'shared/buckets.js'), 'utf8'));
  const client = await readFile(join(SRC, 'client.js'), 'utf8');
  const body = [
    '// src/shared/buckets.js (inlined — export keywords stripped)',
    shared.trimEnd(),
    '',
    '// src/client.js',
    client.trimEnd(),
  ].join('\n');
  assertNoModuleSyntax(body, 'client');
  outputs.set('client.js', envelope(PACKAGE.name, body));
  return outputs;
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const outputs = await renderOutputs();

if (CHECK_ONLY) {
  const stale = [];
  for (const [rel, text] of outputs) {
    let onDisk;
    try {
      onDisk = await readFile(join(LIB, rel), 'utf8');
    } catch {
      stale.push(`${rel}（缺失）`);
      continue;
    }
    if (onDisk !== text) stale.push(`${rel}（src 的构建结果 sha256=${sha(text)}… / 磁盘上 ${sha(onDisk)}…）`);
  }
  if (stale.length > 0) {
    console.error('lib/ 与 src/ 不一致，请运行 npm run build：');
    for (const item of stale) console.error(`  ✗ ${item}`);
    process.exit(1);
  }
  console.log(`lib/ 与 src/ 一致（${String(outputs.size)} 个文件）。`);
  process.exit(0);
}

await rm(LIB, { recursive: true, force: true });
let total = 0;
for (const [rel, text] of outputs) {
  const target = join(LIB, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, 'utf8');
  total += Buffer.byteLength(text);
  console.log(`  · lib/${rel.split('\\').join('/')}  ${String(Buffer.byteLength(text))} bytes  sha256=${sha(text)}…`);
}

console.log(`\n构建完成：lib/ ${String(total)} bytes（${String(outputs.size)} 个文件，${relative(REPO, LIB)}）`);
console.log('宿主半是源码的直接拷贝（ESM，无打包）；客户端半 = 共享算术 + src/client.js + ModuleLoader 外壳。');
