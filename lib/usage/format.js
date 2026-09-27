/**
 * The session-log on-disk format, as the harness itself defines it — read, not
 * guessed, so this plugin can fold logs written by more than one dsh release.
 *
 * Two things about that format have changed across the releases this package
 * supports, and both of them are load-bearing here:
 *
 *   1. **The filename carries the format generation.** `session.jsonl[.zstd]`
 *      is generation 0; every later generation is `session.v<N>.jsonl[.zstd]`.
 *      dsh `0.1.6` wrote `session.v3.jsonl.zstd`, dsh `0.1.7` writes
 *      `session.v4.jsonl.zstd`, and after an in-place upgrade **both files can
 *      sit in the same directory** — a session is migrated by writing the next
 *      immutable generation beside the old one. The reader must therefore not
 *      look for one fixed name; it must pick the highest generation, which is
 *      what `dsh-session-persistence-jsonl` does
 *      (`selectGeneration` → "the numerically highest canonical generation in
 *      one Session directory").
 *
 *   2. **The header line shape changed, and the fork cut moved out of it.** The
 *      first physical line of a log is a flat `{"type":"session", …}` row. In
 *      generations 0–1 it carries `seedLength`; from generation 2 on it does
 *      not carry an inherited-event count at all. Instead the log itself marks
 *      the boundary: a `session/end-seed` event whose `data.inherited` is
 *      `true` sits at exactly the cut, and the cut is that event's `seq`
 *      (`dsh-session-format-v1-to-v2`: `inheritedEventCount = event.seq`;
 *      `releasedV4SessionFormatCodec`'s decoder does the same, and a seeded log
 *      with no such marker makes the harness's own reader **throw**).
 *
 * The predecessor this plugin was ported from read `header.data.inheritedEventCount`
 * and one hardcoded filename. Neither ever existed in a released harness, so a
 * forked session's whole inherited prefix was billed a second time and dsh
 * `0.1.7`'s logs were not found at all. Both are fixed here, and
 * `scripts/verify-compat.mjs` is the suite that keeps them fixed.
 */

/**
 * The canonical basename of one generation, without its compression suffix —
 * character for character the pattern `@deepseek-ai/dsh-session-format` uses:
 * lowercase `v`, decimal, no leading zeros, and **no** `v0` (generation 0 keeps
 * the original untagged name). Names that fail this are not committed
 * generations: temporary files, uppercase, `session.v04.jsonl`, `session.v0.jsonl`.
 */
const CANONICAL_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/;

/** The two physical encodings the persistence backend can be configured with. */
export const COMPRESSION_ZSTD = 'zstd';
export const COMPRESSION_NONE = 'none';

/**
 * Read one directory entry's name as a session-log generation.
 *
 * @param name a basename from a session directory.
 * @returns `{ version, compression }`, or `undefined` when the name is not a
 *   canonical generation name.
 */
export function parseLogName(name) {
  let base = name;
  let compression = COMPRESSION_NONE;
  if (base.endsWith('.zstd')) {
    base = base.slice(0, -'.zstd'.length);
    compression = COMPRESSION_ZSTD;
  }
  const match = CANONICAL_LOG_NAME.exec(base);
  if (match === null) return undefined;
  if (match[1] === undefined) return { version: 0, compression };
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? { version, compression } : undefined;
}

/**
 * Pick the log one session directory should be folded from.
 *
 * Highest generation wins, matching the harness. Ties (the same generation in
 * both encodings — a state the harness refuses rather than reads) are broken
 * towards zstd, and reported by nobody: this plugin is a read-only observer and
 * must not turn a composition the harness merely dislikes into a failed scan.
 *
 * @param names the directory's entry names.
 * @returns `{ file, version, compression }` for the chosen generation, or
 *   `undefined` when the directory holds no canonical generation at all.
 */
export function selectLog(names) {
  let best;
  for (const name of names) {
    const parsed = parseLogName(name);
    if (parsed === undefined) continue;
    const better = best === undefined
      || parsed.version > best.version
      || (parsed.version === best.version && parsed.compression === COMPRESSION_ZSTD);
    if (better) best = { file: name, ...parsed };
  }
  return best;
}

/** One JSON object, or `undefined` — never a throw, never an array. */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * The first physical line of a decoded log.
 *
 * The header is not an event: it carries no `seq`, so the event parser drops it
 * (correctly — dsh's own projection does too). It has to be read off the text
 * directly, which is what this does.
 *
 * @param text the decoded log.
 * @returns the parsed header row, or `undefined` when the log has no readable
 *   first line.
 */
export function readHeaderLine(text) {
  const end = text.indexOf('\n');
  const line = (end === -1 ? text : text.slice(0, end)).trim();
  if (line === '') return undefined;
  try {
    const parsed = JSON.parse(line);
    const row = asRecord(parsed);
    return row === undefined ? undefined : row;
  } catch {
    return undefined;
  }
}

/**
 * Where a log's inherited (forked-in) prefix ends.
 *
 * @param header the header row, or `undefined`.
 * @param events parsed events, in log order.
 * @returns `{ inheritedEventCount, resolved }`. `resolved: false` means the
 *   header *says* the log is seeded but no marker was found, so the cut is
 *   unknown — folding it would bill the parent's prefix a second time, and the
 *   caller must refuse the session rather than invent a number.
 */
export function inheritedCut(header, events) {
  /* Generations 0–1: the count is in the header, flat, as `seedLength`. */
  const seedLength = header?.['seedLength'];
  if (typeof seedLength === 'number' && Number.isSafeInteger(seedLength) && seedLength >= 0) {
    return { inheritedEventCount: seedLength, resolved: true };
  }

  /* The shape the 0.2.0 predecessor read. No released harness wrote it, but a
     log that carries it is unambiguous, so it still wins over refusing. */
  const legacy = asRecord(header?.['data'])?.['inheritedEventCount'];
  if (typeof legacy === 'number' && Number.isSafeInteger(legacy) && legacy >= 0) {
    return { inheritedEventCount: legacy, resolved: true };
  }

  /* Generations 2+: the cut is the seq of the last inherited end-seed marker. */
  let marker;
  for (const event of events) {
    if (event.type !== 'session/end-seed') continue;
    if (asRecord(event.data)?.['inherited'] === true) marker = event.seq;
  }
  if (marker !== undefined) return { inheritedEventCount: marker, resolved: true };

  /* No marker. An unseeded log has no inherited prefix by definition, so this
     is the ordinary case; a seeded one is unreadable, exactly as it is to the
     harness's own decoder. */
  return { inheritedEventCount: 0, resolved: header?.['isSeeded'] !== true };
}

/**
 * The header facts the fold cannot guess.
 *
 * @param header the header row, or `undefined`.
 * @param events parsed events, in log order.
 * @returns `{ version, createdAt, inheritedEventCount, resolved, seeded }`.
 *   `version` is the *logical* generation the row declares, or `undefined` for
 *   an unreadable header — the one number that says which dsh release wrote it.
 */
export function sessionHeader(header, events) {
  const version = header?.['version'];
  const flatCreatedAt = header?.['createdAt'];
  const legacyCreatedAt = asRecord(header?.['data'])?.['createdAt'];
  const createdAt = typeof flatCreatedAt === 'number'
    ? flatCreatedAt
    : typeof legacyCreatedAt === 'number' ? legacyCreatedAt : 0;
  const cut = inheritedCut(header, events);
  return {
    version: typeof version === 'number' && Number.isSafeInteger(version) ? version : undefined,
    createdAt,
    inheritedEventCount: cut.inheritedEventCount,
    resolved: cut.resolved,
    seeded: header?.['isSeeded'] === true,
  };
}
