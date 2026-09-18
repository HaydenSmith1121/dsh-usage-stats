/**
 * The host half's engine: scan → reconcile → persist → report, plus the HTTP
 * route the settings page reads.
 *
 * Two things run on their own clock:
 *
 *   · the **sweep**, every {@link DEFAULT_SWEEP_MS}, which keeps the ledger
 *     current even when nobody has the settings page open. Retention must not
 *     depend on someone looking at the numbers: without the sweep, a session
 *     created and deleted between two page views would never be backed up.
 *   · the **report**, recomputed at most once per {@link DEFAULT_TTL_MS}, so
 *     several tabs opening the page together share one scan.
 *
 * Everything is injected (root, file, clock, logger) — no globals — so the
 * verification scripts can drive the whole thing against a temporary harness
 * home without booting DSH.
 */

import { scanSessions, createScanMemo } from './scan.js';
import { ledgerFileFor, loadLedger, reconcileLedger, saveLedger } from './ledger.js';
import { assembleReport } from './report.js';

export const USAGE_ROUTE = '/plugins/dsh-usage-stats/usage';
export const DEFAULT_TTL_MS = 15_000;
export const DEFAULT_SWEEP_MS = 30_000;
/** How long an unreadable ledger is left alone before it is retried. */
const LEDGER_RETRY_MS = 60_000;

/**
 * @param options.sessionsRoot `$DSH_HOME/sessions`.
 * @param options.dshHome harness home; the ledger path is derived from it.
 * @param options.ledgerFile override the ledger path (tests).
 * @param options.ttlMs report freshness window.
 * @param options.now clock injection (tests).
 * @param options.logger `{ warn(message) }`, optional.
 */
export function createUsageService(options) {
  const sessionsRoot = options.sessionsRoot;
  const ledgerFile = options.ledgerFile ?? ledgerFileFor(options.dshHome);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger;
  const memo = createScanMemo();

  let ledger;
  let loadStatus = 'missing';
  let loadError;
  let loadedAt = 0;
  let writeError;
  let cache;
  let inFlight;
  let lastScan;

  /** Read the ledger once, and re-try only when it could not be read at all. */
  async function ensureLedger(at) {
    if (ledger !== undefined && loadStatus !== 'unavailable') return;
    if (ledger !== undefined && at - loadedAt < LEDGER_RETRY_MS) return;
    const loaded = await loadLedger(ledgerFile, at);
    ledger = loaded.ledger;
    loadStatus = loaded.status;
    loadError = loaded.error;
    loadedAt = at;
  }

  /** One full cycle. Concurrent callers share it. */
  async function refresh() {
    const at = now();
    const scan = await scanSessions(sessionsRoot, memo);
    lastScan = scan;
    await ensureLedger(at);
    const reconciled = reconcileLedger(ledger, scan, at);
    ledger = reconciled.ledger;

    if (reconciled.changed) {
      const saved = await saveLedger(ledgerFile, ledger);
      writeError = saved.ok ? undefined : saved.error;
      if (!saved.ok) logger?.warn?.(`dsh-usage-stats: 台账写入失败，删除会话后将无法保留用量：${String(saved.error)}`);
    }

    const report = assembleReport({
      now: at,
      scan,
      ledger,
      backup: {
        status: backupStatus(),
        path: ledgerFile,
        error: writeError ?? loadError,
      },
    });
    cache = { at, report };
    return report;
  }

  function backupStatus() {
    if (writeError !== undefined) return 'unavailable';
    if (loadStatus === 'unavailable') return 'unavailable';
    if (loadStatus === 'rebuilt') return 'rebuilt';
    return 'ok';
  }

  /** The current report, rescanning at most once per TTL. */
  async function report() {
    const at = now();
    if (cache !== undefined && at - cache.at < ttlMs) return cache.report;
    inFlight ??= refresh().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  /**
   * Start the background sweep.
   *
   * `unref()` matters: a statistics plugin must never be the reason a harness
   * process stays alive.
   */
  function startSweep(sweepMs = DEFAULT_SWEEP_MS) {
    const tick = () => {
      report().catch((error) => {
        logger?.warn?.(`dsh-usage-stats: 用量巡检失败：${String(error?.message ?? error)}`);
      });
    };
    const timer = setInterval(tick, sweepMs);
    timer.unref?.();
    tick();
    return () => {
      clearInterval(timer);
    };
  }

  return {
    report,
    refresh,
    startSweep,
    ledgerPath: ledgerFile,
    /** Introspection for the verification scripts; not part of the wire shape. */
    state: () => ({
      loadStatus,
      loadError,
      writeError,
      backupStatus: backupStatus(),
      cachedAt: cache?.at,
      lastScan: lastScan === undefined
        ? undefined
        : {
          ok: lastScan.ok,
          scannedSessions: lastScan.scannedSessions,
          failedSessions: lastScan.failedSessions,
          reused: lastScan.reused,
        },
    }),
  };
}

/** JSON response helper (same contract as 0.2.0: no-store, explicit length). */
export function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/** Whether a request came from this machine. */
export function loopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** The route handler; loopback-only, read-only, GET/HEAD. */
export function usageHandler(service) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: 'request-not-trusted' });
      return;
    }
    try {
      writeJson(res, 200, await service.report());
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
