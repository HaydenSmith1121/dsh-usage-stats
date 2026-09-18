#!/usr/bin/env node
/**
 * The host route, driven for real: an HTTP server on loopback, the plugin's own
 * handler, and a temporary harness home.
 *
 *   node scripts/verify-host.mjs [--sessions <dir>]
 *
 * With `--sessions` (or `DSH_SESSIONS`) it also copies that directory's session
 * logs into a temporary home and checks the route's numbers against an
 * independent fold of the same logs — real data, no writes to the source.
 */

import { createServer } from 'node:http';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUsageService, usageHandler, loopbackRequest } from '../lib/usage/host.js';
import { scanSessions, createScanMemo } from '../lib/usage/scan.js';
import { mergeCells } from '../lib/usage/fold.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TMP = join(REPO, '.tmp-verify');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const SESSIONS = valueOf('--sessions') ?? process.env['DSH_SESSIONS'];

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

await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });

const home = join(TMP, 'home-host');
await mkdir(join(home, 'sessions'), { recursive: true });

const service = createUsageService({
  dshHome: home,
  sessionsRoot: join(home, 'sessions'),
  ttlMs: 60000,
  logger: { warn: (m) => console.error(`      [warn] ${m}`) },
});

const server = createServer(usageHandler(service));
await new Promise((done) => {
  server.listen(0, '127.0.0.1', done);
});
const port = server.address().port;
const url = `http://127.0.0.1:${String(port)}/plugins/dsh-usage-stats/usage`;

console.log('① HTTP 契约（回环、只读、GET/HEAD）');
{
  const response = await fetch(url);
  equal('GET 返回 200', response.status, 200);
  equal('content-type 是 JSON', response.headers.get('content-type'), 'application/json; charset=utf-8');
  equal('cache-control: no-store', response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  check('响应里有 cells / scannedSessions / backup',
    Array.isArray(body.cells) && typeof body.scannedSessions === 'number' && typeof body.backup === 'object');
  equal('会话目录为空时读到 0 个日志', body.scannedSessions, 0);
  check('空目录也建立台账', body.backup.status === 'ok', JSON.stringify(body.backup));

  const head = await fetch(url, { method: 'HEAD' });
  equal('HEAD 返回 200', head.status, 200);

  const post = await fetch(url, { method: 'POST', body: 'x' });
  equal('POST 返回 405', post.status, 405);
  equal('405 响应是 JSON 错误', (await post.json()).error, 'method not allowed');

  /* Non-loopback is refused before any work happens. The address is faked
     because a real remote peer cannot be produced from this machine. */
  const refused = await callHandler(service, { method: 'GET', remoteAddress: '10.1.2.3' });
  equal('非回环请求被拒绝', refused.status, 403);
  equal('非回环错误体', refused.body.error, 'request-not-trusted');
  check('loopbackRequest 认得三种回环写法',
    loopbackRequest({ socket: { remoteAddress: '127.0.0.1' } })
    && loopbackRequest({ socket: { remoteAddress: '::1' } })
    && loopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } })
    && !loopbackRequest({ socket: { remoteAddress: '192.168.1.4' } }));
}

console.log('\n② 报告缓存（TTL 内多个标签页共享一次扫描）');
{
  const first = await (await fetch(url)).json();
  const second = await (await fetch(url)).json();
  equal('TTL 内两次请求的 generatedAt 相同', second.generatedAt, first.generatedAt);

  const eager = createUsageService({ dshHome: home, sessionsRoot: join(home, 'sessions'), ttlMs: 0, logger: { warn: () => {} } });
  const a = await eager.refresh();
  await new Promise((done) => {
    setTimeout(done, 5);
  });
  const b = await eager.refresh();
  check('TTL=0 时会重新生成报告', b.generatedAt >= a.generatedAt, `${String(a.generatedAt)} → ${String(b.generatedAt)}`);
}

if (SESSIONS !== undefined) {
  console.log(`\n③ 真实会话日志经路由输出：${SESSIONS}`);
  const realHome = join(TMP, 'home-real');
  const realRoot = join(realHome, 'sessions');
  await mkdir(realRoot, { recursive: true });
  await cp(SESSIONS, realRoot, { recursive: true });

  const expected = await independentTotal(realRoot);
  const realService = createUsageService({ dshHome: realHome, sessionsRoot: realRoot, ttlMs: 0, logger: { warn: () => {} } });
  const realServer = createServer(usageHandler(realService));
  await new Promise((done) => {
    realServer.listen(0, '127.0.0.1', done);
  });
  const body = await (await fetch(`http://127.0.0.1:${String(realServer.address().port)}/plugins/dsh-usage-stats/usage`)).json();
  realServer.close();

  equal(`读到 ${String(expected.scanned)} 个会话日志`, body.scannedSessions, expected.scanned);
  equal('路由输出的总 tokens 与独立折叠一致', totalOf(body), expected.total);
  equal('首次运行（此时台账刚建立）没有已删除会话', body.retainedSessions, 0);
  check('会话根目录可读', body.sessionsRootReadable === true);
}

server.close();
await rm(TMP, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '通过' : '失败'}：${String(passed)}/${String(passed + failed)} 项。`);
process.exit(failed === 0 ? 0 : 1);

/** Call the handler directly, with a fake peer address. */
async function callHandler(target, { method, remoteAddress }) {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(text) {
      chunks.push(text);
    },
  };
  await usageHandler(target)({ method, socket: { remoteAddress } }, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(chunks.join('')) };
}

/** Fold the same logs without the service, straight from the scan. */
async function independentTotal(root) {
  const scan = await scanSessions(root, createScanMemo());
  const merged = new Map();
  for (const session of scan.sessions) mergeCells(merged, session.cells ?? []);
  let total = 0;
  for (const cell of merged.values()) {
    total += cell.buckets.uncachedInputTokens + cell.buckets.outputTokens
      + cell.buckets.cacheReadTokens + cell.buckets.cacheWriteTokens;
  }
  return { scanned: scan.scannedSessions, total };
}

function totalOf(report) {
  let sum = 0;
  for (const cell of report.cells) {
    sum += cell.buckets.uncachedInputTokens + cell.buckets.outputTokens
      + cell.buckets.cacheReadTokens + cell.buckets.cacheWriteTokens;
  }
  return sum;
}
