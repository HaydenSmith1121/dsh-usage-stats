#!/usr/bin/env node
/**
 * Fold parity: the 0.3.0 fold must produce byte-identical cells to the 0.2.0
 * fold it replaced.
 *
 * The numbers a user already saw must not move because the package was renamed,
 * so every rule the fold encodes gets a case here — and each case is checked
 * twice: against the *expected* number (so "two implementations agree on
 * something wrong" cannot pass) and against the frozen 0.2.0 reference in
 * `test/reference-fold.js`.
 *
 *   node scripts/verify-fold.mjs                       # rules + synthetic logs
 *   node scripts/verify-fold.mjs --sessions <dir>      # + every real session log
 *   node scripts/verify-fold.mjs --reference <dir>     # + the real 0.2.0 module
 *
 * `--reference` points at an extracted `dsh-workbuddy-quota@0.2.0` package
 * directory (the one under `plugins/dsh-workbuddy-quota/0.1.6-alpha.1/` in
 * HaydenSmith1121/dsh-plugin-collection, unpacked with `tar -xzf`). Without it
 * the frozen copy is used, and the script says which one it used.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeSessionLog } from '../lib/usage/decode.js';
import { foldSession, mergeCells } from '../lib/usage/fold.js';
import { foldLog, scanSessions, createScanMemo } from '../lib/usage/scan.js';
import * as frozen from '../test/reference-fold.js';
import { assistantAttempt, assistantMessage, makeLog, retryStarted, usage, withSeq } from '../test/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TMP = join(REPO, '.tmp-verify');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const SESSIONS = valueOf('--sessions') ?? process.env['DSH_SESSIONS'];
const REFERENCE = valueOf('--reference') ?? process.env['DSH_USAGE_STATS_REFERENCE'];

let failures = 0;
let checks = 0;

function report(ok, label, detail) {
  checks++;
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures++;
  console.error(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`);
}

/** Deterministic comparison form: cells ordered, buckets in a fixed order. */
function normalize(cells) {
  return JSON.stringify(
    [...cells]
      .map((cell) => ({
        day: cell.day,
        provider: cell.provider,
        model: cell.model,
        attempts: cell.attempts,
        buckets: {
          uncachedInputTokens: cell.buckets.uncachedInputTokens,
          outputTokens: cell.buckets.outputTokens,
          cacheReadTokens: cell.buckets.cacheReadTokens,
          cacheWriteTokens: cell.buckets.cacheWriteTokens,
        },
      }))
      .sort((a, b) => `${a.day}${a.provider}${a.model}`.localeCompare(`${b.day}${b.provider}${b.model}`)),
  );
}

function totalsOf(cells) {
  const sum = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 0 };
  for (const cell of cells) {
    sum.uncachedInputTokens += cell.buckets.uncachedInputTokens;
    sum.outputTokens += cell.buckets.outputTokens;
    sum.cacheReadTokens += cell.buckets.cacheReadTokens;
    sum.cacheWriteTokens += cell.buckets.cacheWriteTokens;
    sum.attempts += cell.attempts;
  }
  return sum;
}

/**
 * Load the reference implementation.
 *
 * A real 0.2.0 `lib/index.js` is a bundle whose internals are not exported, so
 * the plugin entry is cut off and an export list appended — the same surgery
 * that produced `test/reference-fold.js`, performed here on the real artifact.
 */
async function loadReference() {
  if (REFERENCE === undefined) return { module: frozen, label: 'frozen copy (test/reference-fold.js)' };
  const entry = (await stat(REFERENCE)).isDirectory() ? join(REFERENCE, 'lib', 'index.js') : REFERENCE;
  const text = await readFile(entry, 'utf8');
  const cut = text.lastIndexOf('// src/index.ts');
  if (cut < 0) throw new Error(`reference file has no plugin entry marker: ${entry}`);
  const body = `${text.slice(0, cut)}\nexport { foldLog, foldSession, scanSessions, decodeSessionLog, parseEvents, localDayKey, mergeCells };\n`;
  await mkdir(TMP, { recursive: true });
  const shim = join(TMP, 'reference-entry.mjs');
  await writeFile(shim, body, 'utf8');
  return { module: await import(pathToFileURL(shim).href), label: entry };
}

const reference = await loadReference();
console.log(`折叠一致性校验（参考实现：${reference.label}）\n`);

const DAY = Date.parse('2026-09-17T10:00:00Z');
const DAY2 = Date.parse('2026-09-18T10:00:00Z');

/** One case: expected buckets/attempts + agreement with the reference. */
function caseFold({ label, events, inherited = 0, fallback = DAY, expect }) {
  const sequenced = withSeq(events);
  const mine = foldSession(sequenced, inherited, fallback);
  const theirs = reference.module.foldSession(sequenced, inherited, fallback);
  report(normalize(mine.cells) === normalize(theirs.cells), `${label} — 与参考实现逐字节一致`,
    `new=${normalize(mine.cells)}\n      ref=${normalize(theirs.cells)}`);
  if (expect !== undefined) {
    const got = totalsOf(mine.cells);
    const ok = got.uncachedInputTokens === expect.uncachedInputTokens
      && got.outputTokens === expect.outputTokens
      && got.cacheReadTokens === expect.cacheReadTokens
      && got.cacheWriteTokens === expect.cacheWriteTokens
      && (expect.attempts === undefined || got.attempts === expect.attempts);
    report(ok, `${label} — 数值符合预期`,
      expect === undefined ? '' : `expect=${JSON.stringify(expect)} got=${JSON.stringify(got)}`);
  }
}

console.log('① 折叠规则（每条规则一个用例）');

caseFold({
  label: '同一步骤内最后一条样本胜出（流式替换）',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
    assistantMessage({ turn: 1, step: 1, usage: usage(300, 30), time: DAY }),
    assistantMessage({ turn: 1, step: 1, usage: usage(500, 50), time: DAY }),
  ],
  expect: { uncachedInputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: '同一步骤重复的同值样本只计一次',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
  ],
  expect: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: '重试开新槽（被重试的那次与被替换的那次都计费）',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
    retryStarted({ turn: 1, step: 1, time: DAY }),
    assistantMessage({ turn: 1, step: 1, usage: usage(250, 25), time: DAY }),
  ],
  expect: { uncachedInputTokens: 350, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 2 },
});

caseFold({
  label: 'assistant/attempt 的 usage 取自内嵌流最后一条 usage chunk',
  events: [
    assistantAttempt({ turn: 2, step: 1, usage: usage(1000, 100, 5000, 200), time: DAY, extraChunks: 3 }),
    assistantMessage({ turn: 2, step: 1, usage: usage(1200, 120, 6000, 0), time: DAY }),
  ],
  expect: { uncachedInputTokens: 1200, outputTokens: 120, cacheReadTokens: 6000, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: '四个桶全为 0 的样本不计入调用次数',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(0, 0), time: DAY }),
    assistantMessage({ turn: 1, step: 2, usage: usage(10, 1), time: DAY }),
  ],
  expect: { uncachedInputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: 'fork 继承的前缀不重复计费',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(999, 99), time: DAY }),
    assistantMessage({ turn: 2, step: 1, usage: usage(100, 10), time: DAY }),
  ],
  inherited: 2,
  expect: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: '无时间戳的事件用会话 createdAt 归日',
  events: [assistantMessage({ turn: 1, step: 1, usage: usage(100, 10) })],
  expect: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

caseFold({
  label: '跨天拆成两个格子',
  events: [
    assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
    assistantMessage({ turn: 2, step: 1, usage: usage(200, 20), time: DAY2 }),
  ],
  expect: { uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 2 },
});

caseFold({
  label: '同一会话内换模型拆成两个格子',
  events: [
    assistantMessage({ turn: 1, step: 1, provider: 'deepseek', model: 'deepseek-chat', usage: usage(100, 10), time: DAY }),
    assistantMessage({ turn: 2, step: 1, provider: 'workbuddy', model: 'claude-sonnet', usage: usage(200, 20), time: DAY }),
  ],
  expect: { uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 2 },
});

caseFold({
  label: '没有任何 usage 样本 → 空报告',
  events: [retryStarted({ turn: 1, step: 1, time: DAY })],
  expect: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 0 },
});

caseFold({
  label: '缺字段的 usage 记录被忽略（不是 0，是不计）',
  events: [
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 5 } }, time: DAY },
    assistantMessage({ turn: 1, step: 2, usage: usage(7, 1), time: DAY }),
  ],
  expect: { uncachedInputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: 1 },
});

console.log('\n② 会话日志解码（多帧 zstd / 截断行 / 无表头）');

const syntheticLogs = [
  { label: '单帧', bytes: makeLog({ createdAt: DAY, events: [assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY })] }) },
  {
    label: '三帧',
    bytes: makeLog({
      createdAt: DAY,
      frames: 3,
      events: [
        assistantMessage({ turn: 1, step: 1, usage: usage(100, 10), time: DAY }),
        assistantAttempt({ turn: 1, step: 2, usage: usage(200, 20, 300), time: DAY }),
        assistantMessage({ turn: 2, step: 1, usage: usage(300, 30), time: DAY2 }),
      ],
    }),
  },
  {
    label: '带 fork 前缀的三帧',
    bytes: makeLog({
      createdAt: DAY,
      frames: 2,
      inheritedEventCount: 2,
      events: [
        assistantMessage({ turn: 1, step: 1, usage: usage(999, 99), time: DAY }),
        assistantMessage({ turn: 2, step: 1, usage: usage(100, 10), time: DAY }),
        assistantMessage({ turn: 2, step: 2, usage: usage(200, 20), time: DAY }),
      ],
    }),
  },
  { label: '无表头（缺 session 事件）', bytes: makeLog({ createdAt: DAY, omitHeader: true, events: [assistantMessage({ turn: 1, step: 1, usage: usage(42, 4) })] }) },
];

for (const item of syntheticLogs) {
  const mine = normalize(foldLog(decodeSessionLog(item.bytes)));
  const theirs = normalize(reference.module.foldLog(reference.module.decodeSessionLog(item.bytes)));
  report(mine === theirs, `${item.label} — 折叠结果与参考实现一致`, `new=${mine}\n      ref=${theirs}`);
}

console.log('\n③ 真实会话日志' + (SESSIONS === undefined ? '（未提供 --sessions，跳过）' : `：${SESSIONS}`));
if (SESSIONS !== undefined) {
  let same = 0;
  let total = 0;
  let bytes = 0;
  const workspaces = await readdir(SESSIONS);
  for (const workspace of workspaces) {
    const workspacePath = join(SESSIONS, workspace);
    if (!(await stat(workspacePath)).isDirectory()) continue;
    for (const id of await readdir(workspacePath)) {
      const file = join(workspacePath, id, 'session.v3.jsonl.zstd');
      let raw;
      try {
        raw = await readFile(file);
      } catch {
        continue;
      }
      total++;
      bytes += raw.length;
      const mine = normalize(foldLog(decodeSessionLog(raw)));
      const theirs = normalize(reference.module.foldLog(reference.module.decodeSessionLog(raw)));
      if (mine === theirs) same++;
      else console.error(`  ✗ ${id} 折叠结果不一致\n      new=${mine}\n      ref=${theirs}`);
    }
  }
  report(same === total && total > 0, `真实会话日志 ${String(same)}/${String(total)} 逐字节一致（${String(Math.round(bytes / 1024))} KiB）`);

  /* The whole-root path, exactly as the plugin runs it: per-session folds merged
     additively. The reference merges as it scans, so the two must still agree. */
  const mineScan = await scanSessions(SESSIONS, createScanMemo());
  const merged = new Map();
  for (const session of mineScan.sessions) mergeCells(merged, session.cells ?? []);
  const mineAll = normalize([...merged.values()]);
  const theirsScan = await reference.module.scanSessions(SESSIONS);
  const theirsAll = normalize(theirsScan.cells);
  report(mineAll === theirsAll, `整根目录合并结果一致（${String(mineScan.scannedSessions)} 个会话日志）`,
    `new=${mineAll}\n      ref=${theirsAll}`);
}

await rm(TMP, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '通过' : '失败'}：${String(checks - failures)}/${String(checks)} 项一致。`);
/* `exitCode` rather than `exit()`: nothing here holds a handle, and letting the
   loop drain avoids the Windows teardown abort a racing exit can trigger. */
process.exitCode = failures === 0 ? 0 : 1;
