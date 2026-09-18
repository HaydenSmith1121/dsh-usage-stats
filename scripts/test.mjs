#!/usr/bin/env node
/**
 * One entry point for the whole suite.
 *
 *   node scripts/test.mjs                                  # offline suites
 *   node scripts/test.mjs --sessions <dir>                 # + real session logs
 *   node scripts/test.mjs --reference <0.2.0 package dir>   # + the real artifact
 *
 * The suites are separate programs on purpose — each one is runnable on its own
 * and prints its own evidence. This wrapper just runs them in order and stops at
 * the first failure, using `stdio: 'inherit'` so the child's output goes
 * straight to the terminal (no pipes, which also keeps it working under
 * sandboxes that forbid piped stdio between processes).
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const sessions = valueOf('--sessions');
const reference = valueOf('--reference');

const passthrough = [];
if (sessions !== undefined) passthrough.push('--sessions', resolve(sessions));
if (reference !== undefined) passthrough.push('--reference', resolve(reference));

const suites = [
  { script: 'scripts/build.mjs', args: ['--check'], label: '构建产物与源码一致' },
  { script: 'scripts/verify-fold.mjs', args: passthrough, label: '折叠一致性（数值不许变）' },
  { script: 'scripts/verify-retention.mjs', args: [], label: '删除会话后用量保留' },
  { script: 'scripts/verify-host.mjs', args: sessions === undefined ? [] : ['--sessions', resolve(sessions)], label: '宿主端路由契约' },
  { script: 'scripts/verify-client.mjs', args: [], label: '客户端半（外壳 + 渲染）' },
];

console.log(`dsh-usage-stats 自检 · ${String(suites.length)} 个套件\n`);

let failed = 0;
for (const suite of suites) {
  console.log(`\n${'─'.repeat(72)}\n▶ ${suite.label}　(${suite.script} ${suite.args.join(' ')})\n`);
  const result = spawnSync(process.execPath, [join(REPO, suite.script), ...suite.args], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    failed++;
    console.error(`\n✗ ${suite.label} 失败（exit ${String(result.status ?? 'null')}）`);
  }
}

console.log(`\n${'─'.repeat(72)}`);
if (failed === 0) {
  console.log(`全部通过：${String(suites.length)} 个套件。`);
  process.exit(0);
}
console.error(`失败：${String(failed)}/${String(suites.length)} 个套件。`);
process.exit(1);
