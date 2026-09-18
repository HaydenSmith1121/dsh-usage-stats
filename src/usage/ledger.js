/**
 * The usage ledger — the grow-only backup that makes deletion survivable.
 *
 * ## Why this file exists
 *
 * Session logs are the only source of truth for token usage, and DSH's
 * `dsh-session-cleanup` (or a plain `rm -rf`) deletes them. Measuring usage by
 * folding those logs therefore loses a session's history the moment the session
 * is deleted. A statistic that drops because the user cleaned up their sidebar
 * is a statistic nobody can plan with.
 *
 * So: every scan folds the live logs, and the *result* is backed up here,
 * per session. Deleting a session log no longer deletes its usage — the ledger
 * still answers for it.
 *
 * ## The two rules
 *
 * 1. **Grow-only.** For one session, a `(day, provider, model)` cell keeps the
 *    larger bucket-wise value of "what is recorded" and "what the log now
 *    says". A log that was compacted, truncated or rewritten must not be able
 *    to lower a figure the harness already emitted.
 * 2. **Nothing is ever removed.** Records are written once and then only ever
 *    updated upward. There is no eviction, no TTL, no size cap. Resetting the
 *    statistics is a deliberate act: delete the file (or its directory) and the
 *    next scan starts a fresh ledger — with the live logs as its baseline.
 *
 * ## Cost
 *
 * One record is a few hundred bytes, so the file grows with the number of
 * sessions this harness has ever seen, not with their size. Writes are atomic
 * (temp file + rename) and only happen when something actually changed.
 *
 * ## Failure handling
 *
 * A ledger that cannot be *read* is not treated as "no ledger": it is moved
 * aside to `<name>.corrupt.json` and a fresh one is started, with the reason
 * reported to the UI (`status: 'rebuilt'`). A ledger that cannot be *written*
 * leaves the report working but says so (`status: 'unavailable'`) — a silent
 * "retention is on" that is actually off would be the worst outcome, because
 * the user would delete sessions believing their usage was safe.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { totalOf } from '../shared/buckets.js';
import { mergeCellsGrowOnly } from './fold.js';

/** Bumped only if the on-disk shape changes incompatibly. */
export const LEDGER_VERSION = 1;

/** Where the ledger lives under a harness home. */
export function ledgerFileFor(dshHome) {
  return join(dshHome, 'storages', 'dsh-usage-stats', 'usage-ledger.json');
}

/** A fresh, empty ledger. */
export function emptyLedger(now) {
  return { version: LEDGER_VERSION, createdAt: now, updatedAt: now, sessions: {} };
}

/** Whether a value looks like a cell we may keep. */
function isCell(value) {
  if (typeof value !== 'object' || value === null) return false;
  const buckets = value['buckets'];
  if (typeof buckets !== 'object' || buckets === null) return false;
  const keys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  for (const key of keys) {
    const n = buckets[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false;
  }
  return typeof value['day'] === 'string'
    && typeof value['provider'] === 'string'
    && typeof value['model'] === 'string'
    && typeof value['attempts'] === 'number';
}

/** Whether one session record is usable; unusable records are dropped, counted. */
function sanitizeSession(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  const cells = Array.isArray(value['cells']) ? value['cells'].filter(isCell) : [];
  const seen = typeof value['firstSeenAt'] === 'number' ? value['firstSeenAt'] : 0;
  const last = typeof value['lastSeenAt'] === 'number' ? value['lastSeenAt'] : seen;
  return {
    firstSeenAt: seen,
    lastSeenAt: last,
    deleted: value['deleted'] === true,
    cells: cells.map((cell) => ({
      day: cell['day'],
      provider: cell['provider'],
      model: cell['model'],
      buckets: { ...cell['buckets'] },
      attempts: cell['attempts'],
    })),
  };
}

/**
 * Load the ledger.
 *
 * @returns `{ ledger, status, error }` where status is one of
 *   - `ok`        read back as written;
 *   - `missing`   no file yet (first run — not an error);
 *   - `rebuilt`   the file was unusable, was moved aside, and a fresh ledger
 *                 was started; `error` says why;
 *   - `unavailable` it exists but could not be read at all (permissions,
 *                 locking); nothing was touched.
 */
export async function loadLedger(file, now) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ledger: emptyLedger(now), status: 'missing', error: undefined };
    return { ledger: emptyLedger(now), status: 'unavailable', error: describe(error) };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ledger: await quarantine(file, now), status: 'rebuilt', error: `台账不是合法 JSON：${describe(error)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || parsed['version'] !== LEDGER_VERSION) {
    const found = typeof parsed === 'object' && parsed !== null ? String(parsed['version']) : typeof parsed;
    return {
      ledger: await quarantine(file, now),
      status: 'rebuilt',
      error: `台账版本不是 ${String(LEDGER_VERSION)}（读到 ${found}）`,
    };
  }

  const sessions = {};
  let dropped = 0;
  const raw = parsed['sessions'];
  if (typeof raw === 'object' && raw !== null) {
    for (const [id, value] of Object.entries(raw)) {
      const session = sanitizeSession(value);
      if (session === undefined) {
        dropped++;
        continue;
      }
      sessions[id] = session;
    }
  }

  const ledger = {
    version: LEDGER_VERSION,
    createdAt: typeof parsed['createdAt'] === 'number' ? parsed['createdAt'] : now,
    updatedAt: typeof parsed['updatedAt'] === 'number' ? parsed['updatedAt'] : now,
    sessions,
  };
  if (dropped > 0) {
    return { ledger, status: 'rebuilt', error: `台账里有 ${String(dropped)} 条会话记录不可用，已跳过` };
  }
  return { ledger, status: 'ok', error: undefined };
}

/** Move an unusable ledger aside (fixed name: this must not be able to pile up). */
async function quarantine(file, now) {
  const aside = `${file}.corrupt.json`;
  try {
    await rename(file, aside);
  } catch {
    /* Best effort — a quarantine failure must not stop the plugin. */
  }
  return emptyLedger(now);
}

/**
 * Persist the ledger atomically.
 *
 * @returns `{ ok, error }`; a failed write is reported, never thrown, because
 *   the report itself is still valid — only retention is not.
 */
export async function saveLedger(file, ledger) {
  const text = `${JSON.stringify(ledger, null, 2)}\n`;
  const tmp = `${file}.tmp-${String(process.pid)}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
    return { ok: true, error: undefined };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

/** Sorted copy of the session map — deterministic file bytes for diffing. */
function sortedSessions(sessions) {
  const out = {};
  for (const id of Object.keys(sessions).sort()) out[id] = sessions[id];
  return out;
}

/**
 * Fold one scan's findings into the ledger.
 *
 * @param ledger the ledger as loaded.
 * @param scan `{ ok, sessions }` where `sessions` holds one entry per session
 *   directory this scan *found*: `{ id, cells }` when its log was read, or
 *   `{ id, failed: true }` when it was not. `ok: false` means the sessions root
 *   itself was unreadable, in which case **no** deletion is inferred: a vanished
 *   mount is not evidence that the user deleted anything.
 * @param now clock, for `lastSeenAt` / `updatedAt`.
 * @returns `{ ledger, changed, stats }` with `stats` describing what the report
 *   can say about retention.
 */
export function reconcileLedger(ledger, scan, now) {
  const next = { ...ledger, sessions: { ...ledger.sessions } };
  const present = new Set();

  for (const session of scan.sessions) {
    present.add(session.id);
    const existing = next.sessions[session.id];
    if (session.failed === true) {
      /* Found but unreadable: keep whatever the ledger already knows, and do
         not claim it is gone. */
      if (existing !== undefined) next.sessions[session.id] = { ...existing, deleted: false, lastSeenAt: now };
      continue;
    }
    const record = existing ?? { firstSeenAt: now, lastSeenAt: now, deleted: false, cells: [] };
    next.sessions[session.id] = {
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: now,
      deleted: false,
      cells: mergeCellsGrowOnly(record.cells, session.cells ?? []),
    };
  }

  if (scan.ok) {
    for (const [id, record] of Object.entries(next.sessions)) {
      if (present.has(id) || record.deleted) continue;
      next.sessions[id] = { ...record, deleted: true };
    }
  }

  next.sessions = sortedSessions(next.sessions);

  const changed = JSON.stringify(next.sessions) !== JSON.stringify(ledger.sessions);
  if (changed) next.updatedAt = now;

  let retainedSessions = 0;
  let retainedTokens = 0;
  let liveSessions = 0;
  for (const [id, record] of Object.entries(next.sessions)) {
    const tokens = record.cells.reduce((sum, cell) => sum + totalOf(cell.buckets), 0);
    if (record.deleted) {
      if (record.cells.length > 0) {
        retainedSessions++;
        retainedTokens += tokens;
      }
      continue;
    }
    if (present.has(id) && record.cells.length > 0) liveSessions++;
  }

  return {
    ledger: next,
    changed,
    stats: {
      liveSessions,
      retainedSessions,
      retainedTokens,
      recordedSessions: Object.keys(next.sessions).length,
    },
  };
}

/** One-line error text for reports and logs. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
