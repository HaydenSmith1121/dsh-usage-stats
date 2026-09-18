/**
 * Assembling the report the UI consumes.
 *
 * The merge rule is the whole point of this plugin, so it is stated once:
 *
 *   · **Within one session** the contribution is the grow-only maximum of the
 *     ledger's record and the live fold — a log that shrank cannot shrink the
 *     report.
 *   · **Across sessions** contributions are added, grouped by
 *     `(day, provider, model)`.
 *   · **A session that is gone still contributes** whatever the ledger holds.
 *     That is the fix: deleting a log deletes the log, not the usage.
 *   · **A session that is currently unreadable** also contributes from the
 *     ledger, so a transient permission or locking problem cannot make the
 *     numbers drop either.
 *
 * What the report never does is *claim* a session was deleted when no completed
 * scan saw it disappear — those records are reported as `unverified*` instead.
 */

import { cellKey, totalOf } from '../shared/buckets.js';
import { mergeCells, mergeCellsGrowOnly } from './fold.js';

/**
 * @param options.now clock for `generatedAt`.
 * @param options.scan scan result from `scanSessions`.
 * @param options.ledger reconciled ledger from `reconcileLedger`.
 * @param options.backup `{ status, path, error }` — retention's own state.
 */
export function assembleReport({ now, scan, ledger, backup }) {
  const merged = new Map();
  const present = new Set();
  let unreadableSessions = 0;
  let unreadableTokens = 0;

  for (const session of scan.sessions) {
    present.add(session.id);
    const record = ledger.sessions[session.id];
    if (session.failed === true) {
      const cells = record?.cells ?? [];
      if (cells.length > 0) {
        unreadableSessions++;
        unreadableTokens += tokensOf(cells);
      }
      mergeCells(merged, cells);
      continue;
    }
    mergeCells(merged, mergeCellsGrowOnly(record?.cells ?? [], session.cells ?? []));
  }

  let retainedSessions = 0;
  let retainedTokens = 0;
  let unverifiedSessions = 0;
  let unverifiedTokens = 0;
  for (const [id, record] of Object.entries(ledger.sessions)) {
    if (present.has(id)) continue;
    if (record.cells.length === 0) continue;
    const tokens = tokensOf(record.cells);
    mergeCells(merged, record.cells);
    if (record.deleted) {
      /* The scan completed and this session was not in it: it is gone, and its
         usage is what the backup is for. */
      retainedSessions++;
      retainedTokens += tokens;
    } else {
      /* Absent, but no completed scan ever confirmed the deletion — an
         unreadable sessions root, say. The numbers are still included (a
         transient outage must not shrink the report), but they are *not*
         presented as "deleted sessions": that claim would be wrong. */
      unverifiedSessions++;
      unverifiedTokens += tokens;
    }
  }

  const cells = [...merged.values()].sort(byCell);
  return {
    generatedAt: now,
    /* Kept from 0.2.0: how many logs this scan actually read, and how many it
       could not. The page's footnote is built from these two numbers. */
    scannedSessions: scan.scannedSessions,
    failedSessions: scan.failedSessions,
    cells,
    /* Whether this scan could look at the sessions root at all. `false` means
       every number below came from the backup. */
    sessionsRootReadable: scan.ok,
    /* Added in 0.3.0: what the backup is holding on the report's behalf. */
    retainedSessions,
    retainedTokens,
    unverifiedSessions,
    unverifiedTokens,
    backup: {
      status: backup.status,
      path: backup.path,
      error: backup.error ?? null,
      sessions: Object.keys(ledger.sessions).length,
      deletedSessions: retainedSessions,
      unreadableSessions,
      unreadableTokens,
      updatedAt: ledger.updatedAt,
    },
  };
}

/** Stable cell order — the wire shape should not depend on Map iteration order. */
function byCell(left, right) {
  return cellKey(left) < cellKey(right) ? -1 : cellKey(left) > cellKey(right) ? 1 : 0;
}

function tokensOf(cells) {
  let sum = 0;
  for (const cell of cells) sum += totalOf(cell.buckets);
  return sum;
}
