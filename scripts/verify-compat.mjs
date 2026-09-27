#!/usr/bin/env node
/**
 * Harness-version compatibility: the on-disk session format, generation by
 * generation.
 *
 * This is the suite for the class of defect that produced 0.3.2. The plugin
 * reads session logs straight off the disk, so it is coupled to two things dsh
 * has moved between releases — and to two things the predecessor it was ported
 * from simply got wrong:
 *
 *   · **The log filename is generation-tagged.** `session.v3.jsonl.zstd` under
 *     dsh `0.1.6`, `session.v4.jsonl.zstd` under `0.1.7`. Reading one fixed
 *     name finds *nothing* on the other train, and the report is all zeros.
 *   · **A migrated session can hold several generations at once.** The harness
 *     reads the numerically highest one; reading the stale one, or reading both,
 *     is wrong in two different directions.
 *   · **The fork cut moved out of the header.** Generations 0–1 carried
 *     `seedLength`; from generation 2 on the header says only `isSeeded`, and
 *     the cut is the seq of the tagged `session/end-seed` row. Missing it bills
 *     a forked session's whole inherited prefix a second time.
 *   · **The header is not an event.** It has no `seq`, so the event parser drops
 *     it. Reading it requires the first physical line, not `parseEvents`.
 *
 *   node scripts/verify-compat.mjs [--sessions <dir>]
 *
 * `--sessions` additionally folds a real harness's session tree and reports the
 * generation mix it found, so the matrix below is not the only evidence.
 */

import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeSessionLog } from '../lib/usage/decode.js';
import { parseLogName, selectLog, sessionHeader, readHeaderLine } from '../lib/usage/format.js';
import { createUsageService } from '../lib/usage/host.js';
import { foldDecoded, readLogHeader, scanSessions, createScanMemo } from '../lib/usage/scan.js';
import { assistantMessage, endSeed, logFileName, makeLog, usage, writeSession } from '../test/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TMP = join(REPO, '.tmp-verify');
const SESSIONS = (() => {
  const at = process.argv.indexOf('--sessions');
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : process.env['DSH_SESSIONS'];
})();

let passed = 0;
let failed = 0;

function check(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
    return true;
  }
  failed++;
  console.error(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
  return false;
}

function equal(label, actual, expected) {
  return check(label, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

const DAY = Date.parse('2026-09-17T10:00:00Z');

// ── an independent second transcription of the two rules ─────────────────────
//
// Deliberately not shared with `lib/usage/format.js`: a check that asks the code
// under test what the answer is cannot catch the code getting the rule wrong.

/** `^session(?:\.v([1-9][0-9]*))?\.jsonl$`, plus the two encodings. */
function independentName(name) {
  const match = /^(session(?:\.v([1-9][0-9]*))?\.jsonl)(\.zstd)?$/.exec(name);
  if (match === null) return undefined;
  return { version: match[2] === undefined ? 0 : Number(match[2]), compression: match[3] === undefined ? 'none' : 'zstd' };
}

/** The cut as the harness derives it: the seq of the last inherited end-seed. */
function independentCut(header, events) {
  if (typeof header?.seedLength === 'number') return header.seedLength;
  let found = 0;
  for (const event of events) {
    if (event.type === 'session/end-seed' && event.data?.inherited === true) found = event.seq;
  }
  return found;
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

// ── ① 日志文件名 ────────────────────────────────────────────────────────────
console.log('① 日志代际文件名（规则抄自 dsh-session-format 的 CANONICAL_LOG_FILENAME）');
{
  const accepted = [
    'session.jsonl',
    'session.jsonl.zstd',
    'session.v1.jsonl.zstd',
    'session.v3.jsonl.zstd',
    'session.v4.jsonl.zstd',
    'session.v4.jsonl',
    'session.v12.jsonl.zstd',
  ];
  for (const name of accepted) {
    equal(`${name} 被识别为 v${String(independentName(name).version)}`,
      parseLogName(name), independentName(name));
  }

  /* Non-canonical names are not committed generations: the harness would not
     read them, so counting them would invent usage no run ever produced. */
  const refused = [
    'session.V4.jsonl.zstd',       // uppercase tag
    'session.v04.jsonl.zstd',      // leading zero
    'session.v0.jsonl.zstd',       // generation 0 is untagged
    'session.v4.jsonl.zstd.tmp',   // temporary
    'session.v4.jsonl.gz',         // unknown encoding
    'session.jsonl.zstd.partial',
    'other.v4.jsonl.zstd',
    'session.v-1.jsonl',
  ];
  for (const name of refused) {
    check(`${name} 不被当成已提交的代际`, parseLogName(name) === undefined, JSON.stringify(parseLogName(name)));
  }
}

// ── ② 一个会话目录里有多代文件时选谁 ────────────────────────────────────────
console.log('\n② 目录内代际选择（升级后旧代文件仍在）');
{
  equal('只有 v4 → 选 v4', selectLog(['session.v4.jsonl.zstd'])?.file, 'session.v4.jsonl.zstd');
  equal('只有 v0 → 选 v0', selectLog(['session.jsonl.zstd'])?.file, 'session.jsonl.zstd');
  equal('v3 与 v4 并存 → 选 v4（dsh 也这么选）', selectLog(['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])?.file, 'session.v4.jsonl.zstd');
  equal('v2/v3/v4 并存 → 选 v4', selectLog(['session.v2.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd'])?.file, 'session.v4.jsonl.zstd');
  equal('v10 比 v9 高（按数值不是按字典序）', selectLog(['session.v9.jsonl.zstd', 'session.v10.jsonl.zstd'])?.file, 'session.v10.jsonl.zstd');
  equal('无后缀明文也能选中', selectLog(['session.v4.jsonl'])?.file, 'session.v4.jsonl');
  equal('只有非代际文件 → 不选', selectLog(['notes.txt', 'session.v4.jsonl.zstd.tmp']), undefined);
  equal('空目录 → 不选', selectLog([]), undefined);

  /* Generated matrix: the production selector and the independent transcription
     must agree on every listing they are both given. */
  const pool = ['session.jsonl', 'session.v1.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v5.jsonl', 'session.V5.jsonl.zstd', 'session.v04.jsonl.zstd', 'readme.md'];
  let agreed = 0;
  let cases = 0;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const names = pool.filter((_, index) => (mask & (1 << index)) !== 0);
    cases++;
    const mine = selectLog(names)?.file;
    const theirs = names
      .map((name) => ({ name, parsed: independentName(name) }))
      .filter((row) => row.parsed !== undefined)
      .sort((left, right) => right.parsed.version - left.parsed.version
        || (right.parsed.compression === 'zstd' ? 1 : 0) - (left.parsed.compression === 'zstd' ? 1 : 0))[0]?.name;
    if (mine === theirs) agreed++;
  }
  check(`${String(cases)} 种目录组合与独立实现选出的代际一致`, agreed === cases, `${String(agreed)}/${String(cases)}`);
}

// ── ③ 表头与 fork 切点 ──────────────────────────────────────────────────────
console.log('\n③ 表头形状与 fork 继承切点（逐代）');
{
  /** Fold a generated log and hand back both the header facts and the cells. */
  const probe = (bytes) => {
    const text = decodeSessionLog(bytes);
    return { header: readLogHeader(text), folded: foldDecoded(text) };
  };

  const plainEvents = [
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
    assistantMessage({ turn: 1, step: 2, usage: usage(200, 20), time: DAY }),
  ];

  for (const format of ['v0', 'v1', 'v3', 'v4']) {
    const unseeded = probe(makeLog({ format, createdAt: DAY, events: plainEvents }));
    const expectedVersion = format === 'v0' ? 0 : format === 'v1' ? 1 : format === 'v3' ? 3 : 4;
    equal(`${format}: 未 fork —— 表头代际为 ${String(expectedVersion)}`, unseeded.header.version, expectedVersion);
    equal(`${format}: 未 fork —— createdAt 取自表头（不是 0）`, unseeded.header.createdAt, DAY);
    equal(`${format}: 未 fork —— 切点为 0`, unseeded.header.inheritedEventCount, 0);
    equal(`${format}: 未 fork —— 两份样本都计入`, unseeded.folded.cells.length, 1);
  }

  /** Two inherited samples, then one of its own. */
  const forkBody = [
    assistantMessage({ turn: 1, step: 1, usage: usage(999, 99), time: DAY }),
    assistantMessage({ turn: 1, step: 2, usage: usage(888, 88), time: DAY }),
    assistantMessage({ turn: 2, step: 1, usage: usage(100, 10), time: DAY }),
  ];

  for (const format of ['v0', 'v1', 'v3', 'v4']) {
    const seeded = probe(makeLog({ format, createdAt: DAY, inheritedEventCount: 2, events: forkBody }));
    equal(`${format}: fork —— 切点 = 2`, seeded.header.inheritedEventCount, 2);
    const buckets = seeded.folded.cells[0]?.buckets;
    equal(`${format}: fork —— 只计自己的那一次（100/10）`,
      [buckets?.uncachedInputTokens, buckets?.outputTokens, seeded.folded.cells[0]?.attempts], [100, 10, 1]);
  }

  /* The cut's own rule, checked against the independent transcription. */
  const text = decodeSessionLog(makeLog({ format: 'v4', createdAt: DAY, inheritedEventCount: 2, events: forkBody }));
  const headerRow = readHeaderLine(text);
  const events = text.split('\n').filter((line) => line !== '').slice(1).map((line) => JSON.parse(line));
  equal('切点与独立实现一致', sessionHeader(headerRow, events).inheritedEventCount, independentCut(headerRow, events));

  /* An untagged marker is a seed boundary, not an inheritance boundary: the
     harness's own readers say so ("an untagged marker does not establish the
     cut"), so it must not move the cut. */
  const untagged = probe(makeLog({
    format: 'v4',
    createdAt: DAY,
    events: [assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }), endSeed({ inherited: false })],
  }));
  equal('未打标 inherited 的 end-seed 不改变切点', untagged.header.inheritedEventCount, 0);

  /* The shape the 0.2.0 predecessor read. No released harness wrote it, but a
     log that carries it is unambiguous and must keep folding as it used to. */
  const legacy = probe(makeLog({ format: 'legacy', createdAt: DAY, inheritedEventCount: 2, events: forkBody }));
  equal('历史 data.inheritedEventCount 形状仍然被认', legacy.header.inheritedEventCount, 2);

  /* A seeded log whose marker is gone is the one case that must be refused:
     inventing a cut bills the parent's prefix again, and dsh's own decoder
     throws on the same log. */
  const headerOnly = Buffer.from(`${JSON.stringify({
    type: 'session', version: 4, id: 'session-x', createdAt: DAY, cwd: 'D:\\ws', isSeeded: true, delegationDepth: 0,
  })}\n${JSON.stringify({ seq: 0, type: 'assistant/message', time: DAY, data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' } }, usage: usage(100, 10) } })}\n`, 'utf8');
  let refused = false;
  try {
    foldDecoded(decodeSessionLog(headerOnly));
  } catch {
    refused = true;
  }
  check('声明 isSeeded 却没有 inherited 标记 → 拒绝折叠（不编造切点）', refused);

  /* No header line at all: still foldable, but the generation is unknown and
   that is reported rather than guessed. */
  const headless = probe(makeLog({ format: 'v4', createdAt: DAY, omitHeader: true, events: plainEvents }));
  equal('无表头 → 代际未知', headless.header.version, undefined);
  equal('无表头 → 仍然折叠出两个样本', headless.folded.cells.length, 1);
}

// ── ④ 端到端：扫描一整棵树 ──────────────────────────────────────────────────
console.log('\n④ 端到端扫描（一棵树里同时有各代际、多代并存、明文、坏文件）');
{
  const home = join(TMP, 'home-compat');
  const root = join(home, 'sessions');
  await mkdir(root, { recursive: true });
  const WS = '--D-workspace--';

  const own = (input, output) => [
    assistantMessage({ turn: 1, step: 1, usage: usage(input, output), time: DAY }),
  ];

  /* One session per shape. `expected` is the total the report must add for it. */
  const cases = [
    { id: 'session-v4', generation: 4, format: 'v4', input: 1000, output: 100, expected: 1100 },
    { id: 'session-v3', generation: 3, format: 'v3', input: 2000, output: 200, expected: 2200 },
    { id: 'session-v1', generation: 1, format: 'v1', input: 3000, output: 300, expected: 3300 },
    { id: 'session-v0', generation: 0, format: 'v0', input: 4000, output: 400, expected: 4400 },
  ];
  for (const item of cases) {
    await writeSession(root, WS, item.id, makeLog({
      format: item.format,
      createdAt: DAY,
      events: own(item.input, item.output),
    }), { generation: item.generation });
  }

  /* An upgraded session: v3 still on disk, v4 current. Only v4 may be counted. */
  const migratedDir = await writeSession(root, WS, 'session-migrated', makeLog({
    format: 'v3', createdAt: DAY, events: own(999_999, 999_999),
  }), { generation: 3 });
  await writeSession(root, WS, 'session-migrated', makeLog({
    format: 'v4', createdAt: DAY, events: own(5000, 500),
  }), { generation: 4 });
  cases.push({ id: 'session-migrated', expected: 5500 });
  check('升级后的会话目录里两代文件都在',
    (await readdir(migratedDir.dir)).sort().join(',') === 'session.v3.jsonl.zstd,session.v4.jsonl.zstd');

  /* The plaintext encoding is a legal configuration of the same backend. */
  await writeSession(root, WS, 'session-plain', makeLog({
    format: 'v4', createdAt: DAY, compress: false, events: own(6000, 600),
  }), { compression: 'none' });
  cases.push({ id: 'session-plain', expected: 6600 });

  /* Non-canonical leftovers must not be counted as a session of their own. */
  await mkdir(join(root, WS, 'session-not-a-log'), { recursive: true });

  const expectedTotal = cases.reduce((sum, item) => sum + item.expected, 0);
  const scan = await scanSessions(root, createScanMemo());
  equal('读到 6 个会话日志', scan.scannedSessions, 6);
  equal('没有读不到的会话', scan.failedSessions, 1); /* the directory with no canonical log */

  const service = createUsageService({ dshHome: home, sessionsRoot: root, ttlMs: 0, logger: { warn: () => {} } });
  const report = await service.refresh();
  let total = 0;
  for (const cell of report.cells) {
    total += cell.buckets.uncachedInputTokens + cell.buckets.outputTokens
      + cell.buckets.cacheReadTokens + cell.buckets.cacheWriteTokens;
  }
  equal('四个代际 + 明文 + 升级会话的总数正确', total, expectedTotal);
  check('升级会话只按 v4 计一次（v3 的 999999 没有被计入）',
    report.cells.every((cell) => cell.buckets.uncachedInputTokens < 999_999),
    JSON.stringify(report.cells.map((cell) => cell.buckets.uncachedInputTokens)));

  equal('报告如实列出读到的日志代际', report.logFormats, [
    { version: 0, sessions: 1 },
    { version: 1, sessions: 1 },
    { version: 3, sessions: 1 },
    { version: 4, sessions: 3 },
  ]);

  /* The defect itself, stated as a regression: on a tree whose only logs are the
     generation dsh 0.1.7 writes, the scan must not come back empty. */
  const zeroHome = join(TMP, 'home-017');
  const zeroRoot = join(zeroHome, 'sessions');
  await mkdir(zeroRoot, { recursive: true });
  await writeSession(zeroRoot, WS, 'session-only-v4', makeLog({
    format: 'v4', createdAt: DAY, events: own(7000, 700),
  }), { generation: 4 });
  const zeroReport = await createUsageService({ dshHome: zeroHome, sessionsRoot: zeroRoot, ttlMs: 0, logger: { warn: () => {} } }).refresh();
  equal('只有 0.1.7 代际的树不再被读成 0 个会话', zeroReport.scannedSessions, 1);
  equal('并且确实给出了数字', zeroReport.cells.length > 0, true);
}

// ── ⑤ 真实会话树 ────────────────────────────────────────────────────────────
console.log(`\n⑤ 真实会话树${SESSIONS === undefined ? '（未提供 --sessions，跳过）' : `：${SESSIONS}`}`);
if (SESSIONS !== undefined) {
  const generations = new Map();
  let unreadable = 0;
  let sessions = 0;
  for (const workspace of await readdir(SESSIONS)) {
    const workspacePath = join(SESSIONS, workspace);
    if (!(await stat(workspacePath)).isDirectory()) continue;
    for (const id of await readdir(workspacePath)) {
      const dir = join(workspacePath, id);
      if (!(await stat(dir)).isDirectory()) continue;
      sessions++;
      const chosen = selectLog(await readdir(dir));
      if (chosen === undefined) {
        unreadable++;
        continue;
      }
      const header = readLogHeader(decodeSessionLog(await readFile(join(dir, chosen.file))));
      const key = header.version ?? 'unknown';
      generations.set(key, (generations.get(key) ?? 0) + 1);
      check(`${id} 的表头代际与文件名一致（v${String(chosen.version)}）`,
        header.version === chosen.version,
        `filename v${String(chosen.version)} vs header v${String(header.version)}`);
    }
  }
  check('每个会话目录都选出了一个代际', unreadable === 0, `${String(unreadable)} 个没有可选日志`);
  console.log(`      代际分布：${[...generations.entries()].map(([v, n]) => `v${String(v)}×${String(n)}`).join(', ')}（共 ${String(sessions)} 个会话目录）`);
}

await rm(TMP, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '通过' : '失败'}：${String(passed)}/${String(passed + failed)} 项。`);
process.exitCode = failed === 0 ? 0 : 1;
