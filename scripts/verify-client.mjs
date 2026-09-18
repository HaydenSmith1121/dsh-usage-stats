#!/usr/bin/env node
/**
 * The client half, evaluated the way the browser carrier evaluates it.
 *
 * `lib/client.js` is not an ES module — it is a factory body inside
 * `window.__ModuleLoader__.load({...})`. Loading it here proves three things a
 * bundler would otherwise hide: the envelope is intact, the concatenation in
 * `scripts/build.mjs` produced valid code with no leftover module syntax, and
 * the page actually renders the retention disclosure it promises.
 *
 * The React stand-in implements only the six hooks the page uses, plus a render
 * loop that lets effects and promises settle and that renders function
 * components — enough to assert on the real component output, no browser
 * required.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const NS = 'settings.usage-stats';

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

// ── the React stand-in ──────────────────────────────────────────────────────

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function makeReact() {
  const state = { hooks: [], index: 0, effects: [], dirty: false };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } };
    },
    useState(initial) {
      const i = state.index++;
      if (!(i in state.hooks)) state.hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [state.hooks[i], (value) => {
        state.hooks[i] = typeof value === 'function' ? value(state.hooks[i]) : value;
        state.dirty = true;
      }];
    },
    useRef(initial) {
      const i = state.index++;
      state.hooks[i] ??= { current: initial };
      return state.hooks[i];
    },
    useCallback(fn, deps) {
      const i = state.index++;
      const prev = state.hooks[i];
      if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.fn;
      state.hooks[i] = { fn, deps };
      return fn;
    },
    useEffect(fn, deps) {
      const i = state.index++;
      const prev = state.hooks[i];
      if (prev !== undefined && sameDeps(prev.deps, deps)) return;
      state.hooks[i] = { deps };
      state.effects.push(fn);
    },
  };
  return { React, state };
}

/** Render until nothing is dirty any more (effects + promise callbacks settle). */
async function render(Component, props, state) {
  let tree;
  for (let pass = 0; pass < 25; pass++) {
    state.index = 0;
    state.effects = [];
    state.dirty = false;
    tree = Component(props);
    const effects = state.effects;
    for (const effect of effects) effect();
    await new Promise((done) => {
      setTimeout(done, 0);
    });
    if (!state.dirty) break;
  }
  return tree;
}

/**
 * Every string the tree would put on screen.
 *
 * Function components are invoked (with a clean hook cursor) because React
 * would: without that, `Metric`'s labels and numbers would be invisible here.
 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out);
    return out;
  }
  if (typeof node !== 'object' || node.props === undefined) return out;
  if (typeof node.type === 'function') {
    textsOf(node.type(node.props), out);
    return out;
  }
  textsOf(node.props.children, out);
  return out;
}

// ── loading the built artifact ──────────────────────────────────────────────

const source = await readFile(join(REPO, 'lib', 'client.js'), 'utf8');

/**
 * One isolated instance of the module: its own React stub, its own hook state,
 * its own registration records. Cases must not share hook state, or a later
 * case would silently assert against an earlier case's screen.
 */
function loadClient() {
  let captured;
  const { React, state } = makeReact();
  const fakeWindow = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const requireShim = (id) => {
    if (id === 'react') return React;
    throw new Error(`unexpected require("${id}")`);
  };

  new Function('window', 'require', source)(fakeWindow, requireShim);
  const api = captured.factory(requireShim);

  const dictionaries = {};
  const registrations = [];
  let effects = 0;
  const ctx = {
    effect(fn) {
      effects++;
      fn();
      return () => {};
    },
    locale: {
      register(ns, dicts) {
        dictionaries[ns] = dicts;
      },
      bind(ns) {
        return (key) => dictionaries[ns]?.zh?.[key] ?? dictionaries[ns]?.en?.[key] ?? key;
      },
    },
    slots: {
      inject(name, run) {
        run();
        return () => {};
      },
      register(descriptor, component) {
        registrations.push({ descriptor, component });
        return () => {};
      },
    },
  };
  api.apply(ctx);

  return {
    api,
    captured,
    state,
    registrations,
    effects: () => effects,
    t: (key) => dictionaries[NS].zh[key],
    hasBothLocales: () => dictionaries[NS]?.zh !== undefined && dictionaries[NS]?.en !== undefined,
  };
}

/** Serve one report (or one failure) through a fetch stand-in, then restore. */
async function withFetch(response, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

// ── ① envelope and exports ──────────────────────────────────────────────────

console.log('① 外壳与导出');
{
  check('文件以 ModuleLoader 外壳开头', source.startsWith('window.__ModuleLoader__.load({ id: "dsh-usage-stats", factory: (require) => {'));
  check('文件里没有残留的 import / export', !/^\s*(import|export)\s/m.test(source));

  const client = loadClient();
  check('外壳调用了 load()', client.captured !== undefined);
  equal('模块 id 正确', client.captured.id, 'dsh-usage-stats');
  equal('exports 三项', Object.keys(client.api).sort(), ['apply', 'inject', 'name']);
  equal('name 正确', client.api.name, 'dsh-usage-stats');
  equal('inject 只要 slots 与 locale', client.api.inject, ['slots', 'locale']);
}

// ── ② registration surface ──────────────────────────────────────────────────

console.log('\n② 注册面（设置分区）');
{
  const client = loadClient();
  equal('注册了一个 seat', client.registrations.length, 1);
  const { descriptor, component } = client.registrations[0];
  equal('seat 是 settings.section', descriptor.name, 'settings.section');
  equal('seat id 是 usage-stats', descriptor.id, 'usage-stats');
  equal('order = 40', descriptor.order, 40);
  equal('导航标签走中文字典', descriptor.label(), 'Token 用量');
  check('组件已注册', typeof component === 'function');
  check('字典注册进 settings.usage-stats', client.hasBothLocales());
  check('用了 ctx.effect 管理生命周期', client.effects() >= 1);
}

// ── ③ rendering with a real report ──────────────────────────────────────────

/* Dated today, in local time, so the default "Today" tab has something to sum:
   a fixture pinned to a fixed date would silently report 0 tomorrow. */
const today = new Date();
const dayKey = `${String(today.getFullYear())}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

const report = {
  generatedAt: Date.now(),
  scannedSessions: 3,
  failedSessions: 1,
  sessionsRootReadable: true,
  retainedSessions: 1,
  retainedTokens: 3600,
  unverifiedSessions: 0,
  cells: [
    { day: dayKey, provider: 'deepseek', model: 'deepseek-chat', attempts: 4, buckets: { uncachedInputTokens: 300, outputTokens: 60, cacheReadTokens: 2000, cacheWriteTokens: 100 } },
    { day: dayKey, provider: 'deepseek', model: 'deepseek-reasoner', attempts: 2, buckets: { uncachedInputTokens: 1000, outputTokens: 140, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ],
  backup: { status: 'ok', path: 'C:\\home\\.dsh\\storages\\dsh-usage-stats\\usage-ledger.json', error: null, sessions: 4, deletedSessions: 1 },
};

const number = (value) => new Intl.NumberFormat(undefined).format(value);

async function screenOf(client, body, response) {
  const { component } = client.registrations[0];
  const tree = await withFetch(response ?? jsonResponse(body), () => render(component, { t: client.t }, client.state));
  return textsOf(tree).join('');
}

console.log('\n③ 页面渲染（用真实报告数据驱动组件）');
{
  const client = loadClient();
  const screen = await screenOf(client, report);

  check('渲染出标题', screen.includes('Token 用量'));
  check(`渲染出今日总 token 数（${number(3600)}）`, screen.includes(number(3600)), screen);
  check('渲染出四个分桶标签', ['未缓存输入', '输出', '缓存读取', '缓存写入'].every((label) => screen.includes(label)), screen);
  /* The four bucket sums, not the per-cell values: uncached 300+1000,
     output 60+140, cache read 2000, cache write 100. */
  check('渲染出四个分桶的合计值',
    [1300, 200, 2000, 100].every((value) => screen.includes(number(value))), screen);
  check('渲染出调用次数 6', screen.includes(number(6)));
  check('脚注报出读到 3 个日志', screen.includes('覆盖 3 个会话日志'), screen);
  check('脚注报出 1 个读不到', screen.includes('1 个无法读取'));
  check('脚注报出被删会话的保留量', screen.includes('已删会话从备份保留 1 个') && screen.includes(number(3600)), screen);
  check('明说「删除会话不会丢用量」', screen.includes('删除会话不会丢用量'));
  check('缓存读占比有渲染', /缓存读取占/.test(screen));
}

console.log('\n④ 台账不可写时必须显式告警');
{
  const client = loadClient();
  const screen = await screenOf(client, {
    ...report,
    backup: { ...report.backup, status: 'unavailable', error: 'EACCES: permission denied' },
  });
  check('渲染出「写不进去」告警', screen.includes('写不进去') && screen.includes('EACCES'), screen);
  check('告警里带上台账路径', screen.includes('usage-ledger.json'));
  check('此时不再宣称「不会丢用量」', !screen.includes('删除会话不会丢用量'));
}

console.log('\n⑤ 台账重建后如实说明');
{
  const client = loadClient();
  const screen = await screenOf(client, {
    ...report,
    backup: { ...report.backup, status: 'rebuilt', error: '台账不是合法 JSON：Unexpected token' },
  });
  check('渲染出重建说明与原因', screen.includes('已重建') && screen.includes('不是合法 JSON'), screen);
}

console.log('\n⑥ 会话目录读不到时说明数字来自备份');
{
  const client = loadClient();
  const screen = await screenOf(client, {
    ...report,
    scannedSessions: 0,
    failedSessions: 0,
    sessionsRootReadable: false,
    unverifiedSessions: 3,
  });
  check('渲染出「读不到会话目录」', screen.includes('读不到会话目录'), screen);
  check('渲染出未核对会话数', screen.includes('3 个本次未能核对'));
}

console.log('\n⑦ 宿主端没加载时给出「重启」而不是裸 404');
{
  const client = loadClient();
  const screen = await screenOf(client, undefined, { ok: false, status: 404, json: async () => ({}) });
  check('提示重启 DSH', screen.includes('请重启 DSH'), screen);
}

console.log('\n⑧ 宿主端返回坏文档时不编造数字');
{
  const client = loadClient();
  const screen = await screenOf(client, { generatedAt: 'yesterday', cells: 'nope' });
  check('渲染出「用量不可用」', screen.includes('用量不可用'), screen);
}

console.log(`\n${failed === 0 ? '通过' : '失败'}：${String(passed)}/${String(passed + failed)} 项。`);
process.exitCode = failed === 0 ? 0 : 1;
