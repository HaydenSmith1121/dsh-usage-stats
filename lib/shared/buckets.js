/**
 * Bucket arithmetic and calendar windows — the vocabulary both halves speak.
 *
 * `scripts/build.mjs` inlines this file into `lib/client.js` (minus the `export`
 * keywords), so the client and the host cannot drift on what "today" means or
 * on how a total is summed. Keep it dependency-free: it must stay valid as a
 * plain module body with no imports.
 */

/** The four provider-reported buckets. `null` prototype is not used: these
 *  objects are spread and JSON-stringified, and a plain object keeps the wire
 *  shape obvious. */
export function emptyBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Sum of all four buckets — what the page shows as "Total tokens". */
export function totalOf(buckets) {
  return buckets.uncachedInputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/** In-place accumulation, used by the client's range sum. */
export function accumulate(into, add) {
  into.uncachedInputTokens += add.uncachedInputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
}

/**
 * Local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Local, not UTC, and not the ISO string slice: a session at 23:30 local time
 * belongs to that local day, and DSH's own day-scoped reports agree.
 */
export function localDayKey(time) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

/** The day key `days` local days before `time` (0 = today). */
export function dayKeyBefore(time, days) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localDayKey(date.getTime());
}

/**
 * Inclusive lower bound of a range, or `undefined` for "all time".
 *
 * Ranges are inclusive local calendar windows ending today, so they nest: the
 * 7-day figure always contains the 1-day figure.
 */
export function rangeFloor(range, now) {
  if (range === 'all') return undefined;
  if (range === 'today') return dayKeyBefore(now, 0);
  if (range === 'd7') return dayKeyBefore(now, 6);
  return dayKeyBefore(now, 29);
}

/** Whether one (day, provider, model) cell belongs to `range` at instant `now`. */
export function cellInRange(cell, range, now) {
  const floor = rangeFloor(range, now);
  return floor === undefined || cell.day >= floor;
}

/** Sum the cells inside `range`, plus the model-call count they carry. */
export function sumRange(cells, range, now) {
  const buckets = emptyBuckets();
  let attempts = 0;
  for (const cell of cells) {
    if (!cellInRange(cell, range, now)) continue;
    accumulate(buckets, cell.buckets);
    attempts += cell.attempts;
  }
  return { ...buckets, totalTokens: totalOf(buckets), attempts };
}

/** `(day, provider, model)` is the cell identity on the wire and in the ledger. */
export function cellKey(cell) {
  return `${cell.day}\u0000${cell.provider}\u0000${cell.model}`;
}
