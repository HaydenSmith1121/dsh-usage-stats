/**
 * Synthetic session logs.
 *
 * Every retention test needs a session it can delete, truncate and append to on
 * demand, so the fixtures build real DSH-shaped logs: concatenated zstd frames
 * of JSONL events, beginning with the flat `{"type":"session", …}` header line
 * the fold reads for `createdAt` and for the fork cut.
 *
 * The header shape and the fork cut are **generation-specific**, and getting
 * that wrong is exactly the defect this suite exists to catch, so the fixtures
 * reproduce each released generation rather than one convenient invention:
 *
 * | `format`   | Header line                                | Fork cut                       |
 * |------------|--------------------------------------------|--------------------------------|
 * | `v0`, `v1` | flat, `seedLength` when seeded             | the header's `seedLength`      |
 * | `v3`, `v4` | flat, `isSeeded` (default)                 | seq of the tagged end-seed row |
 * | `legacy`   | the old synthetic `data.{…}` shape         | `data.inheritedEventCount`     |
 *
 * `legacy` reproduces no released harness — it is the shape the 0.2.0
 * predecessor read, kept so `scripts/verify-fold.mjs` can still hold the fold
 * byte-for-byte against the frozen reference implementation. New cases should
 * use `v3`/`v4`; `scripts/verify-compat.mjs` is where those are asserted.
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

/**
 * The canonical log filename for one generation.
 *
 * Deliberately computed here rather than imported from `lib/usage/format.js`:
 * a fixture that asks the code under test what to name its input cannot detect
 * the parser getting the naming rule wrong.
 *
 * @param generation the format generation (`0` keeps the untagged v0 name).
 * @param compression `'zstd'` (default) or `'none'`.
 */
export function logFileName(generation, compression = 'zstd') {
  const base = generation === 0 ? 'session.jsonl' : `session.v${String(generation)}.jsonl`;
  return compression === 'zstd' ? `${base}.zstd` : base;
}

/** The `session` header row every log starts with, in the shape `format` uses. */
export function sessionHeader({ format = 'v4', createdAt, inheritedEventCount = 0, cwd = 'D:\\ws', id }) {
  const seeded = inheritedEventCount > 0;
  if (format === 'legacy') {
    return { type: 'session', seq: 0, time: createdAt, data: { version: 3, createdAt, cwd, isSeeded: false, inheritedEventCount } };
  }
  const version = format === 'v0' ? 0 : format === 'v1' ? 1 : format === 'v3' ? 3 : 4;
  return {
    type: 'session',
    version,
    id: id ?? `session-${String(createdAt)}`,
    createdAt,
    cwd,
    isSeeded: seeded,
    delegationDepth: 0,
    /* Generations 0–1 carried the cut in the header itself; from generation 2
       on the header says only whether a seed exists and the cut is a log row. */
    ...(version <= 1 && seeded ? { seedLength: inheritedEventCount } : {}),
  };
}

/** `assistant/message` carries usage directly. */
export function assistantMessage({ turn, step, provider = PROVIDER, model = MODEL, usage: buckets, time }) {
  return {
    type: 'assistant/message',
    data: { turn, step, message: { source: { kind: 'model', provider, model } }, usage: buckets },
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
    data: { turn, step, message: { source: { kind: 'model', provider, model } }, stream },
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

/** The tagged row that marks where a fork's inherited prefix ends. */
export function endSeed({ inherited = true } = {}) {
  return { type: 'session/end-seed', data: inherited ? { inherited: true } : {} };
}

/**
 * Assign `seq` in log order.
 *
 * The fold compares `seq` against the inherited cut to skip a forked-in prefix,
 * so events handed straight to `foldSession` need real sequence numbers — an
 * event without one is never "inherited".
 */
export function withSeq(events, start = 1) {
  return events.map((event, index) => ({ ...event, seq: event.seq ?? start + index }));
}

/**
 * Serialise events into a session log.
 *
 * @param options.format header generation; see the table at the top.
 * @param options.createdAt clock for the header (and for undated events).
 * @param options.inheritedEventCount fork prefix size. For `v3`/`v4` the tagged
 *   end-seed row is inserted at exactly that seq, which is what the harness
 *   itself writes (`fork.js`: `seq: boundary + 1`).
 * @param options.events events after the header; `seq` is assigned in order
 *   unless the event already carries one.
 * @param options.frames how many zstd frames to split the JSONL into (DSH
 *   appends frames, so the decoder must survive more than one).
 * @param options.compress `false` writes plaintext JSONL, the other encoding the
 *   persistence backend can be configured with.
 */
export function makeLog({
  format = 'v4',
  createdAt,
  inheritedEventCount = 0,
  cwd,
  id,
  events,
  frames = 1,
  omitHeader = false,
  compress = true,
}) {
  const lines = [];
  if (!omitHeader) {
    lines.push(JSON.stringify(sessionHeader({
      format,
      createdAt,
      inheritedEventCount,
      id,
      ...(cwd === undefined ? {} : { cwd }),
    })));
  }

  const body = [...events];
  const modern = format === 'v3' || format === 'v4';
  if (modern && inheritedEventCount > 0 && !body.some((event) => event.type === 'session/end-seed')) {
    body.splice(inheritedEventCount, 0, endSeed());
  }

  /* Real logs number their events from zero, densely, with the header line
     outside the sequence. */
  let seq = format === 'legacy' ? 1 : 0;
  for (const event of body) {
    lines.push(JSON.stringify({ seq: event.seq ?? seq, ...event }));
    seq++;
  }
  const jsonl = `${lines.join('\n')}\n`;
  if (!compress) return Buffer.from(jsonl, 'utf8');

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

/**
 * Write one session into `<root>/<workspace>/<id>/<generation log>`.
 *
 * @param options.generation format generation for the filename (default 4, the
 *   generation dsh 0.1.7 writes).
 * @param options.compression `'zstd'` or `'none'`.
 */
export async function writeSession(root, workspace, id, bytes, { generation = 4, compression = 'zstd' } = {}) {
  const dir = join(root, workspace, id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, logFileName(generation, compression));
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
export function simpleSession({ createdAt, input = 100, output = 20, day, format = 'v4' }) {
  const time = day === undefined ? createdAt : day;
  const events = [
    assistantMessage({ turn: 1, step: 1, usage: usage(input, output), time }),
    assistantMessage({ turn: 1, step: 2, usage: usage(input * 2, output * 2), time }),
  ];
  return {
    bytes: makeLog({ format, createdAt, events }),
    expected: {
      uncachedInputTokens: input * 3,
      outputTokens: output * 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      attempts: 2,
    },
  };
}
