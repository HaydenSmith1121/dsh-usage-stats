/**
 * The fold: session events → per-(day, provider, model) usage cells.
 *
 * This is a faithful port of `dsh-workbuddy-quota@0.2.0`'s fold, which itself
 * deliberately replicates DSH's own `tokenUsage` projection
 * (`@deepseek-ai/dsh-token-meter`). A report that disagrees with the framework
 * is worse than no report, so the three load-bearing rules are kept verbatim:
 *
 *   1. **The last sample inside one step wins.** A streaming step records
 *      several usage samples for the same `(turn, step)`; each one *replaces*
 *      its predecessor. Naive summation would bill one streamed step many times.
 *   2. **A retry opens a new slot.** `llm/retry-started` closes the current slot
 *      for its `(turn, step)`, so the retried call is counted *in addition to*
 *      the one it replaced — it really was billed twice.
 *   3. **Both `assistant/message` and `assistant/attempt` carry usage.** The
 *      latter is the last `usage` chunk of its own embedded stream.
 *
 * `scripts/verify-fold.mjs` re-derives every session total with this module and
 * compares it against the frozen 0.2.0 implementation, and (when a reference
 * tarball is supplied) against the real predecessor artifact.
 */

import { cellKey, emptyBuckets, localDayKey as dayKey } from '../shared/buckets.js';

/** A fresh, mutable bucket set — the accumulator the fold writes into. */
function zeroMutable() {
  return emptyBuckets();
}

/** Whether all four buckets are zero, i.e. the slot carries nothing to report. */
function isZero(buckets) {
  return buckets.uncachedInputTokens === 0
    && buckets.outputTokens === 0
    && buckets.cacheReadTokens === 0
    && buckets.cacheWriteTokens === 0;
}

/**
 * Provider usage → buckets.
 *
 * `inputTokens` is the *uncached* input on DSH's wire: cache reads and writes
 * are reported separately, and an absent cache field means zero, not unknown.
 */
function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  };
}

/** Bucket-wise equality — how rule 1 recognises "the same sample again". */
function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens;
}

/** Structural check for a provider-reported usage record. */
function isUsage(value) {
  if (typeof value !== 'object' || value === null) return false;
  const row = value;
  return typeof row['inputTokens'] === 'number' && typeof row['outputTokens'] === 'number';
}

/** Last `usage` chunk of an `assistant/attempt`'s embedded stream. */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  let found;
  for (const entry of stream) {
    if (typeof entry !== 'object' || entry === null) continue;
    const chunk = entry['chunk'];
    if (typeof chunk !== 'object' || chunk === null) continue;
    const row = chunk;
    if (row['type'] !== 'usage') continue;
    if (isUsage(row['usage'])) found = row['usage'];
  }
  return found;
}

/** The usage sample an event carries, if any (rule 3). */
function usageOf(event) {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const row = data;
  if (event.type === 'assistant/message') {
    return isUsage(row['usage']) ? row['usage'] : undefined;
  }
  if (event.type !== 'assistant/attempt') return undefined;
  return lastStreamUsage(row['stream']);
}

/** `(turn, step)` identity of an event, as the string the fold keys slots by. */
function stepOf(event) {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const row = data;
  const turn = row['turn'];
  const step = row['step'];
  if (typeof turn !== 'number' || typeof step !== 'number') return undefined;
  return `${String(turn)}:${String(step)}`;
}

/** Provider and model of the message an event belongs to, when it states one. */
function routeOf(event) {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const message = data['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  const source = message['source'];
  if (typeof source !== 'object' || source === null) return undefined;
  const sourceRow = source;
  const provider = sourceRow['provider'];
  if (typeof provider !== 'string') return undefined;
  const model = sourceRow['model'];
  return { provider, model: typeof model === 'string' ? model : '' };
}

/**
 * Fold one session's events into cells.
 *
 * @param events parsed events, in log order.
 * @param inheritedEventCount events below this seq belong to a forked-in
 *   prefix. They are skipped: those events keep the parent session's
 *   timestamps and are already counted with the parent. (DSH's *per-session*
 *   projection counts them, because it answers a different question — "what is
 *   inside this one log".)
 * @param fallbackTime clock used for events that carry no `time` of their own.
 */
export function foldSession(events, inheritedEventCount, fallbackTime) {
  const slots = new Map();
  let last = null;
  let clock = fallbackTime;
  let route = { provider: '', model: '' };
  let fullyDated = true;

  for (const event of events) {
    if (event.seq < inheritedEventCount) continue;

    const dated = typeof event.time === 'number' && Number.isFinite(event.time);
    if (dated) clock = event.time;

    if (event.type === 'llm/retry-started') {
      const step = stepOf(event);
      if (step !== undefined && last !== null && last.step === step) last = null;
      continue;
    }

    const sample = usageOf(event);
    if (sample === undefined) continue;
    const step = stepOf(event);
    if (step === undefined) continue;

    const buckets = bucketsFrom(sample);
    const previous = last !== null && last.step === step ? last.buckets : undefined;
    /* Rule 1: an identical sample for the same step is the stream repeating
       itself, not a second call. */
    if (previous !== undefined && bucketsEqual(previous, buckets)) continue;

    if (!dated) fullyDated = false;
    const eventRoute = routeOf(event);
    if (eventRoute !== undefined) route = eventRoute;

    let stepSlots = slots.get(step);
    if (stepSlots === undefined) {
      stepSlots = [];
      slots.set(step, stepSlots);
    }

    let index;
    if (previous !== undefined && last !== null) {
      /* Same step, different numbers: replace the slot this step already owns. */
      index = last.index;
      stepSlots[index] = { buckets, time: clock, provider: route.provider, model: route.model };
    } else {
      stepSlots.push({ buckets, time: clock, provider: route.provider, model: route.model });
      index = stepSlots.length - 1;
    }
    last = { step, index, buckets };
  }

  const cells = new Map();
  let attempts = 0;
  for (const stepSlots of slots.values()) {
    for (const slot of stepSlots) {
      if (isZero(slot.buckets)) continue;
      attempts++;
      const day = dayKey(slot.time);
      const key = `${day}\u0000${slot.provider}\u0000${slot.model}`;
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { day, provider: slot.provider, model: slot.model, buckets: zeroMutable(), attempts: 0 };
        cells.set(key, cell);
      }
      cell.buckets.uncachedInputTokens += slot.buckets.uncachedInputTokens;
      cell.buckets.outputTokens += slot.buckets.outputTokens;
      cell.buckets.cacheReadTokens += slot.buckets.cacheReadTokens;
      cell.buckets.cacheWriteTokens += slot.buckets.cacheWriteTokens;
      cell.attempts++;
    }
  }

  const out = [];
  for (const cell of cells.values()) {
    out.push({
      day: cell.day,
      provider: cell.provider,
      model: cell.model,
      buckets: {
        uncachedInputTokens: cell.buckets.uncachedInputTokens,
        outputTokens: cell.buckets.outputTokens,
        cacheReadTokens: cell.buckets.cacheReadTokens,
        cacheWriteTokens: cell.buckets.cacheWriteTokens,
      },
      attempts: cell.attempts,
    });
  }
  return { cells: out, attempts, fullyDated };
}

/**
 * Additive merge of cells sharing a `(day, provider, model)` key — the merge
 * used when several *different* sessions contribute to the same day.
 */
export function mergeCells(into, cells) {
  for (const cell of cells) {
    const key = cellKey(cell);
    const existing = into.get(key);
    if (existing === undefined) {
      into.set(key, cell);
      continue;
    }
    into.set(key, {
      day: existing.day,
      provider: existing.provider,
      model: existing.model,
      buckets: {
        uncachedInputTokens: existing.buckets.uncachedInputTokens + cell.buckets.uncachedInputTokens,
        outputTokens: existing.buckets.outputTokens + cell.buckets.outputTokens,
        cacheReadTokens: existing.buckets.cacheReadTokens + cell.buckets.cacheReadTokens,
        cacheWriteTokens: existing.buckets.cacheWriteTokens + cell.buckets.cacheWriteTokens,
      },
      attempts: existing.attempts + cell.attempts,
    });
  }
}

/** Bucket-wise maximum — the merge the ledger uses so a record never shrinks. */
export function maxBuckets(left, right) {
  return {
    uncachedInputTokens: Math.max(left.uncachedInputTokens, right.uncachedInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    cacheReadTokens: Math.max(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
  };
}

/**
 * Grow-only merge of two cell lists for the *same* session.
 *
 * Per `(day, provider, model)` key the larger bucket wins. The ledger is a
 * backup, and a backup that can shrink is not a backup: a compacted or
 * rewritten log must not be able to lower a figure the harness already billed.
 */
export function mergeCellsGrowOnly(recorded, incoming) {
  const merged = new Map();
  for (const cell of recorded) merged.set(cellKey(cell), cell);
  for (const cell of incoming) {
    const key = cellKey(cell);
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, cell);
      continue;
    }
    merged.set(key, {
      day: existing.day,
      provider: existing.provider,
      model: existing.model,
      buckets: maxBuckets(existing.buckets, cell.buckets),
      attempts: Math.max(existing.attempts, cell.attempts),
    });
  }
  return [...merged.values()];
}
