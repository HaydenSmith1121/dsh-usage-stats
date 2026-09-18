/**
 * Client half of `dsh-usage-stats` — the "Token usage" settings page.
 *
 * ★ This file is the **body of the client module factory**, not a standalone
 *   ES module. `scripts/build.mjs` wraps it in DSH's `window.__ModuleLoader__`
 *   envelope so the carrier can serve it, and prepends `src/shared/buckets.js`
 *   (with its `export` keywords stripped) — that is where `emptyBuckets`,
 *   `totalOf`, `accumulate`, `sumRange`, `rangeFloor`, `localDayKey` and
 *   `dayKeyBefore` come from. The concatenation is why the range arithmetic in
 *   the page and in the host cannot drift apart.
 *
 *   `require` is the carrier's module resolver, so React arrives exactly the
 *   way DSH's own client modules get it — no bundler, no build-time React.
 */

const React = require('react');

const NS = 'settings.usage-stats';
const USAGE_ROUTE = '/plugins/dsh-usage-stats/usage';
const POLL_INTERVAL_MS = 60000;
const RANGES = ['today', 'd7', 'd30', 'all'];

const en = {
  /** Navigation label of the token-usage settings page. */
  usageNav: 'Token usage',
  usageTitle: 'Token usage',
  usageSubtitle: 'Provider-reported tokens recorded in this harness\u2019s session logs, backed up session by session.',
  usageRefresh: 'Refresh',
  usageLoading: 'Reading session logs\u2026',
  usageFailed: 'Usage unavailable: {message}',
  usageNeedsRestart: 'Restart DSH to finish enabling this page \u2014 the host half that reads session logs is not loaded in the running process yet.',
  usageRangeToday: 'Today',
  usageRange7: 'Last 7 days',
  usageRange30: 'Last 30 days',
  usageRangeAll: 'All time',
  usageTotalTokens: 'Total tokens',
  usageUncachedInput: 'Uncached input',
  usageUncachedInputHint: 'Prompt tokens billed in full',
  usageOutput: 'Output',
  usageOutputHint: 'Completion tokens, reasoning included',
  usageCacheRead: 'Cache read',
  usageCacheReadHint: 'Prompt tokens served from cache',
  usageCacheWrite: 'Cache write',
  usageCacheWriteHint: 'Prompt tokens written to cache',
  usageCacheShare: '{percent} of this total is cache reads',
  usageAttempts: '{count} model calls',
  usageScope: 'Across {sessions} session logs',
  usageScopeFailed: '\xB7 {failed} unreadable',
  usageRetained: '\xB7 {sessions} deleted sessions kept from the backup ({tokens} tokens)',
  usageUnreadableBackedUp: '\xB7 {sessions} unreadable, served from the backup',
  usageUnverified: '\xB7 {sessions} could not be checked this scan, served from the backup',
  usageRootUnreadable: 'The sessions directory could not be read this scan \u2014 every figure comes from the backup.',
  usageBackupRebuilt: 'The usage backup was unusable and has been rebuilt ({reason}) \u2014 usage retained before this point is no longer counted.',
  usageBackupUnavailable: 'The usage backup at {path} cannot be written ({reason}), so deleting a session will delete its usage. Fix the path\u2019s permissions to restore retention.',
  usageBackupWhat: 'Deleting a session keeps its usage: totals are backed up per session and only ever grow.',
  usageUpdatedAt: 'updated {time}'
};

const zh = {
  usageNav: 'Token \u7528\u91CF',
  usageTitle: 'Token \u7528\u91CF',
  usageSubtitle: '\u6765\u81EA\u672C\u673A\u4F1A\u8BDD\u65E5\u5FD7\u3001\u7531\u670D\u52A1\u65B9\u4E0A\u62A5\u7684\u771F\u5B9E token \u6570\uFF0C\u6309\u4F1A\u8BDD\u9010\u4E2A\u5907\u4EFD\u3002',
  usageRefresh: '\u5237\u65B0',
  usageLoading: '\u6B63\u5728\u8BFB\u53D6\u4F1A\u8BDD\u65E5\u5FD7\u2026',
  usageFailed: '\u7528\u91CF\u4E0D\u53EF\u7528\uFF1A{message}',
  usageNeedsRestart: '\u8BF7\u91CD\u542F DSH \u4EE5\u542F\u7528\u672C\u9875\u2014\u2014\u8BFB\u53D6\u4F1A\u8BDD\u65E5\u5FD7\u7684\u5BBF\u4E3B\u7AEF\u8FD8\u6CA1\u5728\u5F53\u524D\u8FDB\u7A0B\u91CC\u52A0\u8F7D\u3002',
  usageRangeToday: '\u4ECA\u65E5',
  usageRange7: '\u8FD1 7 \u5929',
  usageRange30: '\u8FD1 30 \u5929',
  usageRangeAll: '\u5168\u90E8',
  usageTotalTokens: '\u603B token \u6570',
  usageUncachedInput: '\u672A\u7F13\u5B58\u8F93\u5165',
  usageUncachedInputHint: '\u6309\u539F\u4EF7\u8BA1\u8D39\u7684\u63D0\u793A\u8BCD token',
  usageOutput: '\u8F93\u51FA',
  usageOutputHint: '\u8865\u5168 token\uFF0C\u542B\u601D\u8003\u8FC7\u7A0B',
  usageCacheRead: '\u7F13\u5B58\u8BFB\u53D6',
  usageCacheReadHint: '\u547D\u4E2D\u7F13\u5B58\u7684\u63D0\u793A\u8BCD token',
  usageCacheWrite: '\u7F13\u5B58\u5199\u5165',
  usageCacheWriteHint: '\u5199\u5165\u7F13\u5B58\u7684\u63D0\u793A\u8BCD token',
  usageCacheShare: '\u5176\u4E2D\u7F13\u5B58\u8BFB\u53D6\u5360 {percent}',
  usageAttempts: '\u5171 {count} \u6B21\u6A21\u578B\u8C03\u7528',
  usageScope: '\u8986\u76D6 {sessions} \u4E2A\u4F1A\u8BDD\u65E5\u5FD7',
  usageScopeFailed: '\xB7 {failed} \u4E2A\u65E0\u6CD5\u8BFB\u53D6',
  usageRetained: '\xB7 \u5DF2\u5220\u4F1A\u8BDD\u4ECE\u5907\u4EFD\u4FDD\u7559 {sessions} \u4E2A\uFF08{tokens} tokens\uFF09',
  usageUnreadableBackedUp: '\xB7 {sessions} \u4E2A\u8BFB\u4E0D\u5230\uFF0C\u6570\u5B57\u6765\u81EA\u5907\u4EFD',
  usageUnverified: '\xB7 {sessions} \u4E2A\u672C\u6B21\u672A\u80FD\u6838\u5BF9\uFF0C\u6570\u5B57\u6765\u81EA\u5907\u4EFD',
  usageRootUnreadable: '\u672C\u6B21\u8BFB\u4E0D\u5230\u4F1A\u8BDD\u76EE\u5F55\u2014\u2014\u6240\u6709\u6570\u5B57\u90FD\u6765\u81EA\u5907\u4EFD\u3002',
  usageBackupRebuilt: '\u7528\u91CF\u5907\u4EFD\u66FE\u4E0D\u53EF\u7528\uFF0C\u5DF2\u91CD\u5EFA\uFF08{reason}\uFF09\u2014\u2014 \u91CD\u5EFA\u4E4B\u524D\u4FDD\u7559\u7684\u7528\u91CF\u4E0D\u518D\u8BA1\u5165\u3002',
  usageBackupUnavailable: '\u7528\u91CF\u5907\u4EFD {path} \u5199\u4E0D\u8FDB\u53BB\uFF08{reason}\uFF09\uFF0C\u5220\u9664\u4F1A\u8BDD\u4F1A\u540C\u65F6\u5220\u6389\u5B83\u7684\u7528\u91CF\u3002\u6062\u590D\u8BE5\u8DEF\u5F84\u7684\u6743\u9650\u5373\u53EF\u91CD\u65B0\u751F\u6548\u3002',
  usageBackupWhat: '\u5220\u9664\u4F1A\u8BDD\u4E0D\u4F1A\u4E22\u7528\u91CF\uFF1A\u5404\u4F1A\u8BDD\u7684\u7528\u91CF\u5DF2\u9010\u4E2A\u5907\u4EFD\uFF0C\u53EA\u589E\u4E0D\u51CF\u3002',
  usageUpdatedAt: '\u66F4\u65B0\u4E8E {time}'
};

/** `{placeholder}` interpolation — the dictionaries above are the only inputs. */
function translate(t, key, params) {
  const template = t(key, params);
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// ── wire parsing ────────────────────────────────────────────────────────────

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseBuckets(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value;
  const uncachedInputTokens = count(row['uncachedInputTokens']);
  const outputTokens = count(row['outputTokens']);
  const cacheReadTokens = count(row['cacheReadTokens']);
  const cacheWriteTokens = count(row['cacheWriteTokens']);
  if (uncachedInputTokens === undefined || outputTokens === undefined
    || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function isDayKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseBackup(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const row = value;
  const status = row['status'];
  if (status !== 'ok' && status !== 'rebuilt' && status !== 'unavailable') return undefined;
  return {
    status,
    path: typeof row['path'] === 'string' ? row['path'] : '',
    error: typeof row['error'] === 'string' ? row['error'] : undefined,
    sessions: count(row['sessions']) ?? 0,
    deletedSessions: count(row['deletedSessions']) ?? 0,
    unreadableSessions: count(row['unreadableSessions']) ?? 0
  };
}

/**
 * Validate the host's document rather than trusting it.
 *
 * A malformed cell is dropped, not rendered as `NaN`: an invented number is
 * worse than a smaller report, and the footnote still says how many logs were
 * read.
 */
function parseUsageReport(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const document_ = value;
  const generatedAt = count(document_['generatedAt']);
  const scannedSessions = count(document_['scannedSessions']);
  const failedSessions = count(document_['failedSessions']);
  if (generatedAt === undefined || scannedSessions === undefined || failedSessions === undefined) return undefined;
  const rawCells = document_['cells'];
  if (!Array.isArray(rawCells)) return undefined;

  const cells = [];
  for (const entry of rawCells) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry;
    if (!isDayKey(row['day'])) continue;
    const buckets = parseBuckets(row['buckets']);
    if (buckets === undefined) continue;
    const attempts = count(row['attempts']);
    if (attempts === undefined) continue;
    cells.push({
      day: row['day'],
      provider: typeof row['provider'] === 'string' ? row['provider'] : '',
      model: typeof row['model'] === 'string' ? row['model'] : '',
      buckets,
      attempts
    });
  }

  return {
    generatedAt,
    scannedSessions,
    failedSessions,
    cells,
    sessionsRootReadable: document_['sessionsRootReadable'] !== false,
    retainedSessions: count(document_['retainedSessions']) ?? 0,
    retainedTokens: count(document_['retainedTokens']) ?? 0,
    unverifiedSessions: count(document_['unverifiedSessions']) ?? 0,
    backup: parseBackup(document_['backup'])
  };
}

// ── presentation ────────────────────────────────────────────────────────────

function formatNumber(value) {
  return new Intl.NumberFormat(undefined).format(value);
}

function formatPercent(fraction) {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(fraction);
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

const h = React.createElement;

function Metric({ label, value, hint }) {
  return h('div', { style: metricStyle },
    h('div', { style: metricLabelStyle }, label),
    h('div', { style: metricValueStyle }, value),
    h('div', { style: metricHintStyle }, hint));
}

function UsageSection({ t }) {
  const translateKey = (key) => (typeof t === 'function' ? t(key) : FALLBACK[key]);
  const say = (key, params) => translate(translateKey, key, params);

  const [range, setRange] = React.useState('today');
  const [reading, setReading] = React.useState({ kind: 'loading' });
  const [now, setNow] = React.useState(() => Date.now());
  const alive = React.useRef(true);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch(USAGE_ROUTE, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' }
      });
      if (response.status === 404) {
        if (alive.current) setReading({ kind: 'needsRestart' });
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = parseUsageReport(await response.json().catch(() => undefined));
      if (parsed === undefined) throw new Error('invalid usage document');
      if (!alive.current) return;
      setReading({ kind: 'ready', report: parsed });
      setNow(Date.now());
    } catch (error) {
      if (!alive.current) return;
      setReading({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  React.useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const report = reading.kind === 'ready' ? reading.report : undefined;
  const totals = report === undefined ? undefined : sumRange(report.cells, range, now);
  const backup = report?.backup;

  return h('div', { style: pageStyle },
    h('header', { style: headerStyle },
      h('div', null,
        h('h2', { style: titleStyle }, say('usageTitle')),
        h('p', { style: subtitleStyle }, say('usageSubtitle'))),
      h('button', {
        type: 'button',
        style: refreshStyle,
        onClick: () => {
          void refresh();
        }
      }, say('usageRefresh'))),

    h('div', { style: tabsStyle, role: 'tablist', 'aria-label': say('usageTitle') },
      RANGES.map((key) => h('button', {
        key,
        type: 'button',
        role: 'tab',
        'aria-selected': range === key,
        style: range === key ? tabActiveStyle : tabStyle,
        onClick: () => {
          setRange(key);
        }
      }, say(RANGE_LABEL[key])))),

    reading.kind === 'loading' && h('p', { style: mutedStyle }, say('usageLoading')),
    reading.kind === 'needsRestart' && h('p', { style: mutedStyle }, say('usageNeedsRestart')),
    reading.kind === 'failed' && h('p', { style: errorStyle }, say('usageFailed', { message: reading.message })),

    totals !== undefined && report !== undefined && h(React.Fragment, null,
      h('div', { style: totalCardStyle },
        h('div', { style: totalValueStyle }, formatNumber(totals.totalTokens)),
        h('div', { style: totalLabelStyle }, say('usageTotalTokens'))),

      h('div', { style: gridStyle },
        h(Metric, {
          label: say('usageUncachedInput'),
          value: formatNumber(totals.uncachedInputTokens),
          hint: say('usageUncachedInputHint')
        }),
        h(Metric, {
          label: say('usageOutput'),
          value: formatNumber(totals.outputTokens),
          hint: say('usageOutputHint')
        }),
        h(Metric, {
          label: say('usageCacheRead'),
          value: formatNumber(totals.cacheReadTokens),
          hint: say('usageCacheReadHint')
        }),
        h(Metric, {
          label: say('usageCacheWrite'),
          value: formatNumber(totals.cacheWriteTokens),
          hint: say('usageCacheWriteHint')
        })),

      totals.totalTokens > 0 && h('p', { style: mutedStyle },
        say('usageCacheShare', { percent: formatPercent(totals.cacheReadTokens / totals.totalTokens) }),
        ' \xB7 ',
        say('usageAttempts', { count: formatNumber(totals.attempts) })),

      h('p', { style: footnoteStyle },
        say('usageScope', { sessions: formatNumber(report.scannedSessions) }),
        report.failedSessions > 0 && h(React.Fragment, null,
          ' ',
          say('usageScopeFailed', { failed: formatNumber(report.failedSessions) })),
        backup !== undefined && backup.unreadableSessions > 0 && h(React.Fragment, null,
          ' ',
          say('usageUnreadableBackedUp', { sessions: formatNumber(backup.unreadableSessions) })),
        report.unverifiedSessions > 0 && h(React.Fragment, null,
          ' ',
          say('usageUnverified', { sessions: formatNumber(report.unverifiedSessions) })),
        report.retainedSessions > 0 && h(React.Fragment, null,
          ' ',
          say('usageRetained', {
            sessions: formatNumber(report.retainedSessions),
            tokens: formatNumber(report.retainedTokens)
          })),
        ' \xB7 ',
        say('usageUpdatedAt', { time: formatTime(report.generatedAt) })),

      /* Retention is the reason this plugin exists, so its state is never
         implied: it is stated when it works, and stated louder when it does
         not. */
      report.sessionsRootReadable === false && h('p', { style: warningStyle }, say('usageRootUnreadable')),
      backup !== undefined && backup.status === 'ok' && h('p', { style: footnoteStyle }, say('usageBackupWhat')),
      backup !== undefined && backup.status === 'rebuilt' && h('p', { style: warningStyle },
        say('usageBackupRebuilt', { reason: backup.error ?? '' })),
      backup !== undefined && backup.status === 'unavailable' && h('p', { style: errorStyle },
        say('usageBackupUnavailable', { path: backup.path, reason: backup.error ?? '' }))));
}

const RANGE_LABEL = {
  today: 'usageRangeToday',
  d7: 'usageRange7',
  d30: 'usageRange30',
  all: 'usageRangeAll'
};

/** Used only when no locale service is available (the page must still render). */
const FALLBACK = en;

const pageStyle = { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 16px' };
const headerStyle = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 };
const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
const subtitleStyle = { margin: '2px 0 0', fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' };
const refreshStyle = {
  flexShrink: 0,
  height: 26,
  padding: '0 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: 'inherit',
  fontSize: 12,
  cursor: 'pointer'
};
const tabsStyle = {
  display: 'flex',
  gap: 4,
  padding: 3,
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
  alignSelf: 'flex-start'
};
const tabStyle = {
  height: 24,
  padding: '0 10px',
  border: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  /* Longhands rather than the `font: 'inherit'` shorthand: the active tab
     overrides `fontWeight`, and React warns (correctly) when a rerender drops
     a shorthand while a longhand for the same value stays set. */
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 400,
  whiteSpace: 'nowrap',
  cursor: 'pointer'
};
const tabActiveStyle = {
  ...tabStyle,
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'var(--dsw-alias-label-primary)',
  fontWeight: 600,
  boxShadow: 'var(--dsw-shadow-lv1)'
};
const totalCardStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '14px 16px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1, #fff)'
};
const totalValueStyle = {
  fontSize: 28,
  fontWeight: 600,
  lineHeight: '34px',
  color: 'var(--dsw-alias-label-primary)',
  fontVariantNumeric: 'tabular-nums'
};
const totalLabelStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' };
const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 8
};
const metricStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1, #fff)'
};
const metricLabelStyle = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' };
const metricValueStyle = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
  fontVariantNumeric: 'tabular-nums'
};
const metricHintStyle = { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary)' };
const mutedStyle = { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' };
const errorStyle = {
  margin: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-error, #d33)'
};
const warningStyle = {
  margin: 0,
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-warning, #b26a00)'
};
const footnoteStyle = { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' };

// ── plugin entry ────────────────────────────────────────────────────────────

const name = 'dsh-usage-stats';
const inject = ['slots', 'locale'];

function apply(ctx) {
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-usage-stats: copy dictionaries');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'usage-stats',
      order: 40,
      label: () => t('usageNav'),
      inject: () => ({ t })
    }, UsageSection));
  } catch (error) {
    console.error('[dsh-usage-stats] token-usage page failed to load (model routing unaffected):', error);
  }
}

module.exports = { apply, inject, name };
