/**
 * Synthetic session logs.
 *
 * Every retention test needs a session it can delete, truncate and append to on
 * demand, so the fixtures build real DSH-shaped logs: concatenated zstd frames
 * of JSONL events, with the `session` header the fold reads for `createdAt` and
 * `inheritedEventCount`.
 *
 * Everything here is offline and deterministic — no real session log is needed
 * to run the suite, and no real session log is ever written to.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

export const PROVIDER = 'deepseek';
export const MODEL = 'deepseek-chat';

/** Provider usage record, with the two cache buckets defaulted to zero. */
export function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** The `session` header event every log starts with. */
export function sessionHeader({ createdAt, inheritedEventCount = 0, cwd = 'D:\\ws' }) {
  return {
    type: 'session',
    seq: 0,
    time: createdAt,
    data: { version: 3, createdAt, cwd, isSeeded: false, inheritedEventCount },
  };
}

/** `assistant/message` carries usage directly. */
export function assistantMessage({ turn, step, provider = PROVIDER, model = MODEL, usage: buckets, time }) {
  return {
    type: 'assistant/message',
    data: { turn, step, message: { source: { provider, model } }, usage: buckets },
    ...(time === undefined ? {} : { time }),
  };
}

/** `assistant/attempt` carries usage as the last `usage` chunk of its stream. */
export function assistantAttempt({ turn, step, provider = PROVIDER, model = MODEL, usage: buckets, time, extraChunks = 0 }) {
  const stream = [];
  for (let i = 0; i < extraChunks; i++) stream.push({ chunk: { type: 'text', text: `chunk ${String(i)}` } });
  if (buckets !== undefined) stream.push({ chunk: { type: 'usage', usage: buckets } });
  return {
    type: 'assistant/attempt',
    data: { turn, step, message: { source: { provider, model } }, stream },
    ...(time === undefined ? {} : { time }),
  };
}

/** A retry closes the current slot for its `(turn, step)`. */
export function retryStarted({ turn, step, time }) {
  return {
    type: 'llm/retry-started',
    data: { turn, step },
    ...(time === undefined ? {} : { time }),
  };
}

/**
 * Assign `seq` in log order.
 *
 * The fold compares `seq` against the header's `inheritedEventCount` to skip a
 * forked-in prefix, so events handed straight to `foldSession` need real
 * sequence numbers — an event without one is never "inherited".
 */
export function withSeq(events, start = 1) {
  return events.map((event, index) => ({ ...event, seq: event.seq ?? start + index }));
}

/**
 * Serialise events into a session log.
 *
 * @param options.createdAt clock for the header (and for undated events).
 * @param options.inheritedEventCount fork prefix size.
 * @param options.events events after the header; `seq` is assigned in order
 *   unless the event already carries one.
 * @param options.frames how many zstd frames to split the JSONL into (DSH
 *   appends frames, so the decoder must survive more than one).
 */
export function makeLog({ createdAt, inheritedEventCount = 0, cwd, events, frames = 1, omitHeader = false }) {
  const lines = [];
  if (!omitHeader) lines.push(JSON.stringify(sessionHeader({ createdAt, inheritedEventCount, ...(cwd === undefined ? {} : { cwd }) })));
  let seq = 1;
  for (const event of events) {
    lines.push(JSON.stringify({ seq: event.seq ?? seq, ...event }));
    seq++;
  }
  const jsonl = `${lines.join('\n')}\n`;

  const count = Math.max(1, frames);
  const per = Math.ceil(jsonl.length / count);
  const out = [];
  for (let i = 0; i < count; i++) {
    const slice = jsonl.slice(i * per, (i + 1) * per);
    if (slice === '') continue;
    out.push(zstdCompressSync(Buffer.from(slice, 'utf8')));
  }
  return Buffer.concat(out);
}

/** Write one session into `<root>/<workspace>/<id>/session.v3.jsonl.zstd`. */
export async function writeSession(root, workspace, id, bytes) {
  const dir = join(root, workspace, id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'session.v3.jsonl.zstd');
  await writeFile(file, bytes);
  return { dir, file };
}

/**
 * Replace a session's log — used to simulate a compacted or truncated log,
 * which is the case the grow-only rule exists for.
 */
export async function rewriteSession(file, bytes) {
  await writeFile(file, bytes);
}

/**
 * A small, complete log: two model calls on two turns.
 *
 * Returns bytes plus the buckets it should fold to, so a test can assert the
 * expected number instead of merely comparing two implementations.
 */
export function simpleSession({ createdAt, input = 100, output = 20, day }) {
  const time = day === undefined ? createdAt : day;
  const events = [
    assistantMessage({ turn: 1, step: 1, usage: usage(input, output), time }),
    assistantMessage({ turn: 1, step: 2, usage: usage(input * 2, output * 2), time }),
  ];
  return {
    bytes: makeLog({ createdAt, events }),
    expected: {
      uncachedInputTokens: input * 3,
      outputTokens: output * 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      attempts: 2,
    },
  };
}
