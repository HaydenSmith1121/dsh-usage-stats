/**
 * Walking `$DSH_HOME/sessions/` — one fold per session, memoised by file
 * identity so a periodic sweep stays cheap.
 *
 * Layout on disk is two levels deep: `sessions/<workspace>/<session id>/
 * session.v3.jsonl.zstd`, where the workspace segment is the working directory
 * with separators and colons flattened (`--D-deepseek--`).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeSessionLog, parseEvents } from './decode.js';
import { foldSession } from './fold.js';

/** The one file a session directory must hold to be countable. */
export const SESSION_FILE = 'session.v3.jsonl.zstd';

/**
 * Fold a whole session log.
 *
 * The `session` header carries two things the fold cannot guess: how many
 * leading events were inherited from a fork (skipped — they are billed with the
 * parent) and when the session was created (the clock for events that carry no
 * time of their own).
 */
export function foldLog(text) {
  const events = parseEvents(text);
  const header = events.find((event) => event.type === 'session');
  const headerData = header?.data;
  const row = typeof headerData === 'object' && headerData !== null ? headerData : {};
  const inherited = typeof row['inheritedEventCount'] === 'number' ? row['inheritedEventCount'] : 0;
  const createdAt = typeof row['createdAt'] === 'number' ? row['createdAt'] : 0;
  return foldSession(events, inherited, createdAt).cells;
}

/**
 * A fold cache keyed by session id.
 *
 * Appends change `mtimeMs` (and usually `size`), so an unchanged pair means the
 * log has not been touched since the last fold. Without this, every sweep would
 * re-read and re-inflate every session log in the harness.
 */
export function createScanMemo() {
  return new Map();
}

/**
 * Scan every session under `root`.
 *
 * @param root `$DSH_HOME/sessions`.
 * @param memo fold cache from {@link createScanMemo}; mutated in place.
 * @returns `{ ok, sessions, scannedSessions, failedSessions, reused, bytes }`.
 *   `ok: false` means the sessions root itself could not be listed — callers
 *   must not read that as "every session was deleted".
 */
export async function scanSessions(root, memo) {
  const result = { ok: false, sessions: [], scannedSessions: 0, failedSessions: 0, reused: 0, bytes: 0 };

  let workspaces;
  try {
    workspaces = await readdir(root);
  } catch {
    return result;
  }
  result.ok = true;

  for (const workspace of workspaces) {
    const workspacePath = join(root, workspace);
    let sessions;
    try {
      if (!(await stat(workspacePath)).isDirectory()) continue;
      sessions = await readdir(workspacePath);
    } catch {
      /* One unreadable workspace counts once, not once per session inside it. */
      result.failedSessions++;
      continue;
    }

    for (const id of sessions) {
      const sessionPath = join(workspacePath, id);
      const logPath = join(sessionPath, SESSION_FILE);
      try {
        if (!(await stat(sessionPath)).isDirectory()) continue;
      } catch {
        result.failedSessions++;
        continue;
      }

      let fileStat;
      try {
        fileStat = await stat(logPath);
      } catch {
        /* A session directory without its log: nothing to fold. */
        result.failedSessions++;
        continue;
      }

      const cached = memo.get(id);
      if (cached !== undefined && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        result.sessions.push({ id, cells: cached.cells });
        result.scannedSessions++;
        result.reused++;
        result.bytes += fileStat.size;
        continue;
      }

      try {
        const bytes = await readFile(logPath);
        const cells = foldLog(decodeSessionLog(bytes));
        memo.set(id, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, cells });
        result.sessions.push({ id, cells });
        result.scannedSessions++;
        result.bytes += bytes.length;
      } catch {
        result.sessions.push({ id, failed: true });
        result.failedSessions++;
      }
    }
  }

  return result;
}
