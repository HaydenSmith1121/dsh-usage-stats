#!/usr/bin/env node
/**
 * Retention: deleting a session must not delete its usage.
 *
 * This is the regression suite for the defect that produced 0.3.0. Each case
 * builds a real harness home under `.tmp-verify/`, writes real session logs into
 * it, and drives the host service through `createUsageService` — the same code
 * path the plugin runs. Nothing touches `$DSH_HOME`.
 *
 *   node scripts/verify-retention.mjs [--keep]
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUsageService } from '../lib/usage/host.js';
import { ledgerFileFor } from '../lib/usage/ledger.js';
import { scanSessions, createScanMemo } from '../lib/usage/scan.js';
import { mergeCells } from '../lib/usage/fold.js';
import { assistantMessage, makeLog, simpleSession, usage, writeSession } from '../test/fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TMP = join(REPO, '.tmp-verify');
const KEEP = process.argv.includes('--keep');

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
  return check(label, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
}

/** Total tokens across every cell of a report. */
function totalTokens(report) {
  let sum = 0;
  for (const cell of report.cells) {
    sum += cell.buckets.uncachedInputTokens + cell.buckets.outputTokens
      + cell.buckets.cacheReadTokens + cell.buckets.cacheWriteTokens;
  }
  return sum;
}

function attemptsOf(report) {
  return report.cells.reduce((sum, cell) => sum + cell.attempts, 0);
}

/** What 0.2.0 would have reported for the sessions currently on disk. */
async function liveOnlyTotal(sessionsRoot) {
  const scan = await scanSessions(sessionsRoot, createScanMemo());
  const merged = new Map();
  for (const session of scan.sessions) mergeCells(merged, session.cells ?? []);
  let sum = 0;
  for (const cell of merged.values()) {
    sum += cell.buckets.uncachedInputTokens + cell.buckets.outputTokens
      + cell.buckets.cacheReadTokens + cell.buckets.cacheWriteTokens;
  }
  return { total: sum, scanned: scan.scannedSessions };
}

const WS = '--D-workspace--';
const DAY = Date.parse('2026-09-17T09:00:00Z');

/** A home with three sessions whose exact totals are known. */
async function makeHome(name) {
  const home = join(TMP, name);
  const sessionsRoot = join(home, 'sessions');
  const a = simpleSession({ createdAt: DAY, input: 100, output: 20 });   // 300 / 60
  const b = simpleSession({ createdAt: DAY, input: 1000, output: 200 }); // 3000 / 600
  const c = simpleSession({ createdAt: DAY, input: 7, output: 1 });      // 21 / 3
  const files = {};
  files.a = (await writeSession(sessionsRoot, WS, 'session-aaa', a.bytes)).file;
  files.b = (await writeSession(sessionsRoot, WS, 'session-bbb', b.bytes)).file;
  files.c = (await writeSession(sessionsRoot, WS, 'session-ccc', c.bytes)).file;
  return {
    home,
    sessionsRoot,
    files,
    totals: {
      a: a.expected,
      b: b.expected,
      c: c.expected,
      sum: 300 + 60 + 3000 + 600 + 21 + 3,
      attempts: 6,
    },
  };
}

function serviceFor(home, extra = {}) {
  return createUsageService({
    dshHome: home,
    sessionsRoot: join(home, 'sessions'),
    ttlMs: 0,
    logger: { warn: (message) => console.error(`      [warn] ${message}`) },
    ...extra,
  });
}

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

// ── ① 基线：台账被建立，数字与三份日志的折叠结果一致 ──────────────────────────
console.log('① 基线（首次扫描：建立台账）');
{
  const world = await makeHome('home-1');
  const service = serviceFor(world.home);
  const report = await service.refresh();

  equal('总 tokens = 三份日志之和', totalTokens(report), world.totals.sum);
  equal('调用次数 = 6', attemptsOf(report), world.totals.attempts);
  equal('读到 3 个会话日志', report.scannedSessions, 3);
  equal('没有已删除会话', report.retainedSessions, 0);
  equal('台账状态 ok', report.backup.status, 'ok');
  equal('台账已记录 3 个会话', report.backup.sessions, 3);

  const ledger = JSON.parse(await readFile(ledgerFileFor(world.home), 'utf8'));
  equal('台账文件落盘：3 条会话记录', Object.keys(ledger.sessions).length, 3);
  check('台账里的会话都还没被标记删除', Object.values(ledger.sessions).every((s) => s.deleted === false));

  // ── ② 删除会话：这正是 0.2.0 的缺陷 ───────────────────────────────────────
  console.log('\n② 删除会话（缺陷回归）');
  await rm(join(world.sessionsRoot, WS, 'session-bbb'), { recursive: true, force: true });
  const after = await service.refresh();

  equal('删除一个会话后总 tokens 不变', totalTokens(after), world.totals.sum);
  equal('读到的日志变成 2 个', after.scannedSessions, 2);
  equal('已删除会话 = 1（用量被保留）', after.retainedSessions, 1);
  equal('保留的 tokens = 被删会话的用量', after.retainedTokens, 3000 + 600);
  equal('调用次数不变', attemptsOf(after), world.totals.attempts);

  const old = await liveOnlyTotal(world.sessionsRoot);
  equal('对照：0.2.0 的口径此刻只剩 2 个日志的用量', old.total, world.totals.sum - 3600);
  check('修复生效：新口径比旧口径多出的正好是被删会话', totalTokens(after) - old.total === 3600,
    `new=${String(totalTokens(after))} old=${String(old.total)}`);

  // ── ③ 重启后仍然保留 ─────────────────────────────────────────────────────
  console.log('\n③ 进程重启（换一个服务实例读同一份台账）');
  const restarted = serviceFor(world.home);
  const afterRestart = await restarted.refresh();
  equal('重启后总 tokens 仍然不变', totalTokens(afterRestart), world.totals.sum);
  equal('重启后已删除会话仍被保留', afterRestart.retainedSessions, 1);

  // ── ④ 会话继续增长：只增不减 ──────────────────────────────────────────────
  console.log('\n④ 会话继续追加用量');
  const grown = makeLog({
    createdAt: DAY,
    events: [
      assistantMessage({ turn: 1, step: 1, usage: usage(100, 20), time: DAY }),
      assistantMessage({ turn: 1, step: 2, usage: usage(200, 40), time: DAY }),
      assistantMessage({ turn: 2, step: 1, usage: usage(1000, 100), time: DAY }),
    ],
  });
  await writeFile(world.files.a, grown);
  const afterGrow = await serviceFor(world.home).refresh();
  equal('追加后总 tokens = 原值 + 新增（+1100）', totalTokens(afterGrow), world.totals.sum + 1100);
  equal('已删除会话不受影响', afterGrow.retainedSessions, 1);

  // ── ⑤ 日志被压缩/截断：备份不许缩水 ───────────────────────────────────────
  console.log('\n⑤ 日志被压缩（备份只增不减）');
  const shrunken = makeLog({
    createdAt: DAY,
    events: [assistantMessage({ turn: 1, step: 1, usage: usage(1, 1), time: DAY })],
  });
  await writeFile(world.files.a, shrunken);
  const afterShrink = await serviceFor(world.home).refresh();
  equal('日志缩水后总 tokens 不下降', totalTokens(afterShrink), world.totals.sum + 1100);

  const ledgerAfterShrink = JSON.parse(await readFile(ledgerFileFor(world.home), 'utf8'));
  const recordA = ledgerAfterShrink.sessions['session-aaa'];
  check('台账里 session-aaa 的格子仍是较大的那一份',
    recordA.cells.some((cell) => cell.buckets.uncachedInputTokens >= 1000),
    JSON.stringify(recordA.cells));

  // ── ⑥ 台账损坏：重建并如实报出，不崩 ──────────────────────────────────────
  console.log('\n⑥ 台账损坏');
  await writeFile(ledgerFileFor(world.home), '{ this is not json', 'utf8');
  const afterCorrupt = await serviceFor(world.home).refresh();
  equal('状态报为 rebuilt', afterCorrupt.backup.status, 'rebuilt');
  check('损坏文件被移到 .corrupt.json', await exists(`${ledgerFileFor(world.home)}.corrupt.json`));
  equal('数字回落到只剩在场日志（诚实，而非编造）', totalTokens(afterCorrupt), await liveOnlyTotal(world.sessionsRoot).then((r) => r.total));
  const rebuilt = JSON.parse(await readFile(ledgerFileFor(world.home), 'utf8'));
  check('损坏后写回了合法台账', typeof rebuilt.sessions === 'object' && rebuilt.version === 1);

  // ── ⑦ 台账不可写：报告照常，但明说保留失效 ────────────────────────────────
  console.log('\n⑦ 台账不可写');
  const blockedHome = join(TMP, 'home-blocked');
  await mkdir(blockedHome, { recursive: true });
  await writeFile(join(blockedHome, 'blocker'), 'not a directory', 'utf8');
  const blocked = createUsageService({
    dshHome: blockedHome,
    sessionsRoot: world.sessionsRoot,
    ledgerFile: join(blockedHome, 'blocker', 'usage-ledger.json'),
    ttlMs: 0,
    logger: { warn: () => {} },
  });
  const blockedReport = await blocked.refresh();
  equal('状态报为 unavailable', blockedReport.backup.status, 'unavailable');
  check('报告仍然给出数字', totalTokens(blockedReport) === (await liveOnlyTotal(world.sessionsRoot)).total);
  check('错误原因被带出来', typeof blockedReport.backup.error === 'string' && blockedReport.backup.error.length > 0,
    String(blockedReport.backup.error));

  // ── ⑧ 会话根目录不见了：不许据此判断「全被删了」 ──────────────────────────
  console.log('\n⑧ 会话根目录整体不可读');
  const world2 = await makeHome('home-2');
  const service2 = serviceFor(world2.home);
  const before = await service2.refresh();
  await rm(join(world2.sessionsRoot, WS, 'session-bbb'), { recursive: true, force: true });
  const oneDeleted = await service2.refresh();
  equal('删一个会话后保留 1 个', oneDeleted.retainedSessions, 1);
  await rename(world2.sessionsRoot, `${world2.sessionsRoot}-moved`);
  const offline = await serviceFor(world2.home).refresh();
  equal('根目录消失时数字不塌（全部来自台账）', totalTokens(offline), totalTokens(before));
  equal('根目录消失不被当成「全删了」', offline.retainedSessions, 1);
  equal('未核对的会话被单独报出', offline.unverifiedSessions, 2);
  equal('并明确说明本次读不到会话根目录', offline.sessionsRootReadable, false);
  await rename(`${world2.sessionsRoot}-moved`, world2.sessionsRoot);
  const restored = await serviceFor(world2.home).refresh();
  equal('恢复后数字一致', totalTokens(restored), totalTokens(before));
  equal('恢复后保留计数仍然只有那一个', restored.retainedSessions, 1);
  equal('恢复后没有未核对项', restored.unverifiedSessions, 0);

  // ── ⑨ 同 id 重新出现：取两边较大者，不重复计 ──────────────────────────────
  /* Own home on purpose: case ⑥ deliberately destroys a ledger, so reusing that
     world here would assert against data the test itself threw away. */
  console.log('\n⑨ 被删会话的同名 id 重新出现');
  const world5 = await makeHome('home-5');
  const service5 = serviceFor(world5.home);
  const seeded = await service5.refresh();
  equal('基线 = 三份日志之和', totalTokens(seeded), world5.totals.sum);
  await rm(join(world5.sessionsRoot, WS, 'session-bbb'), { recursive: true, force: true });
  const gone = await serviceFor(world5.home).refresh();
  equal('删除后用量被保留', totalTokens(gone), world5.totals.sum);
  equal('已删除会话 = 1', gone.retainedSessions, 1);
  const small = simpleSession({ createdAt: DAY, input: 5, output: 1 });
  await writeSession(world5.sessionsRoot, WS, 'session-bbb', small.bytes);
  const reappeared = await serviceFor(world5.home).refresh();
  equal('同名 id 回来后取较大的一份，不叠加', totalTokens(reappeared), world5.totals.sum);
  equal('该会话不再算作已删除', reappeared.retainedSessions, 0);

  // ── ⑩ 后台巡检：没人打开页面也会记台账 ────────────────────────────────────
  console.log('\n⑩ 后台巡检（不依赖有人打开设置页）');
  const world3 = await makeHome('home-3');
  const sweeping = serviceFor(world3.home, { ttlMs: 60000 });
  const stop = sweeping.startSweep(20);
  await sleep(120);
  const sweptLedger = JSON.parse(await readFile(ledgerFileFor(world3.home), 'utf8'));
  stop();
  equal('巡检已把 3 个会话写进台账', Object.keys(sweptLedger.sessions).length, 3);
  check('巡检期间没有调用过 report()', true);

  // ── ⑪ 确定性 ──────────────────────────────────────────────────────────────
  console.log('\n⑪ 重复刷新结果稳定');
  const world4 = await makeHome('home-4');
  const service4 = serviceFor(world4.home);
  const first = await service4.refresh();
  const second = await service4.refresh();
  equal('两次刷新的 cells 完全相同', JSON.stringify(first.cells), JSON.stringify(second.cells));
  equal('两次刷新的 generatedAt 允许不同（时钟），其余字段一致',
    JSON.stringify({ ...first, generatedAt: 0, backup: { ...first.backup, updatedAt: 0 } }),
    JSON.stringify({ ...second, generatedAt: 0, backup: { ...second.backup, updatedAt: 0 } }));
}

if (!KEEP) await rm(TMP, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '通过' : '失败'}：${String(passed)}/${String(passed + failed)} 项。`);
process.exit(failed === 0 ? 0 : 1);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}
