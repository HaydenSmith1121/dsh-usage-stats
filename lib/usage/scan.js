/**
 * Walking `$DSH_HOME/sessions/` — one fold per session, memoised by file
 * identity so a periodic sweep stays cheap.
 *
 * The directory layout is two levels deep and has been stable across every
 * release this package supports: `sessions/<workspace>/<session id>/<log>`,
 * where the workspace segment is the working directory with separators and
 * colons flattened (`--D-project--`), or `_no-cwd` for a session that recorded
 * none.
 *
 * What is *not* stable is the log's own name and header — both are
 * generation-tagged, and `./format.js` is where that knowledge lives.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeSessionLog, parseEvents } from './decode.js';
import { readHeaderLine, selectLog, sessionHeader } from './format.js';
import { foldSession } from './fold.js';

/**
 * Fold one decoded session log, header included.
 *
 * The header carries two things the fold cannot guess: how many leading events
 * were inherited from a fork (skipped — those keep the parent's timestamps and
 * are billed with the parent) and when the session was created (the clock for
 * events that carry no time of their own).
 *
 * @param text a decoded session log.
 * @returns `{ header, cells }`.
 * @throws when the log declares itself seeded but does not name its cut. dsh's
 *   own decoder throws on exactly that log, so guessing here would invent a
 *   second, disagreeing answer to a question the framework already refuses.
 */
export function foldDecoded(text) {
  const events = parseEvents(text);
  const header = sessionHeader(readHeaderLine(text), events);
  if (!header.resolved) {
    throw new Error('seeded session log has no inherited end-seed marker: the fork cut is unknown');
  }
  return { header, cells: foldSession(events, header.inheritedEventCount, header.createdAt).cells };
}

/** {@link foldDecoded}, cells only — the shape the fold-parity suite compares. */
export function foldLog(text) {
  return foldDecoded(text).cells;
}

/** The header facts of a decoded log, without folding it. */
export function readLogHeader(text) {
  return sessionHeader(readHeaderLine(text), parseEvents(text));
}

/**
 * A fold cache keyed by session id.
 *
 * Appends change `mtimeMs` (and usually `size`), so an unchanged triple means
 * the log has not been touched since the last fold. The resolved filename is
 * part of the key because an upgrade can *replace which generation is current*
 * while leaving the previous file's own timestamp alone. Without this memo,
 * every sweep would re-read and re-inflate every session log in the harness.
 */
export function createScanMemo() {
  return new Map();
}

/**
 * Scan every session under `root`.
 *
 * @param root `$DSH_HOME/sessions`.
 * @param memo fold cache from {@link createScanMemo}; mutated in place.
 * @returns `{ ok, sessions, scannedSessions, failedSessions, reused, bytes,
 *   formats }`. `ok: false` means the sessions root itself could not be listed
 *   — callers must not read that as "every session was deleted". `formats`
 *   counts the log generations actually folded, keyed by the generation the
 *   header declares (`'unknown'` for a log whose header is unreadable but which
 *   is unseeded, and therefore still foldable).
 */
export async function scanSessions(root, memo) {
  const result = {
    ok: false,
    sessions: [],
    scannedSessions: 0,
    failedSessions: 0,
    reused: 0,
    bytes: 0,
    formats: new Map(),
  };

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
      try {
        if (!(await stat(sessionPath)).isDirectory()) continue;
      } catch {
        result.failedSessions++;
        continue;
      }

      /* Which generation this session is currently on. A directory holding no
         canonical generation is a session with no log: nothing to fold. */
      let chosen;
      try {
        chosen = selectLog(await readdir(sessionPath));
      } catch {
        result.failedSessions++;
        continue;
      }
      if (chosen === undefined) {
        result.failedSessions++;
        continue;
      }

      const logPath = join(sessionPath, chosen.file);
      let fileStat;
      try {
        fileStat = await stat(logPath);
        if (!fileStat.isFile()) throw new Error('not a regular file');
      } catch {
        result.failedSessions++;
        continue;
      }

      const cached = memo.get(id);
      if (cached !== undefined
        && cached.file === chosen.file
        && cached.mtimeMs === fileStat.mtimeMs
        && cached.size === fileStat.size) {
        result.sessions.push({ id, cells: cached.cells });
        result.scannedSessions++;
        result.reused++;
        result.bytes += fileStat.size;
        countFormat(result.formats, cached.format);
        continue;
      }

      try {
        const bytes = await readFile(logPath);
        const { header, cells } = foldDecoded(decodeSessionLog(bytes));
        memo.set(id, {
          file: chosen.file,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
          cells,
          format: header.version,
        });
        result.sessions.push({ id, cells });
        result.scannedSessions++;
        result.bytes += bytes.length;
        countFormat(result.formats, header.version);
      } catch {
        result.sessions.push({ id, failed: true });
        result.failedSessions++;
      }
    }
  }

  return result;
}

/** One more session seen on generation `version`; `undefined` is "unreadable". */
function countFormat(formats, version) {
  const key = version ?? 'unknown';
  formats.set(key, (formats.get(key) ?? 0) + 1);
}
