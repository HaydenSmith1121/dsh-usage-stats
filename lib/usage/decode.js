/**
 * Session-log decoding: DSH stores one session as a file of concatenated zstd
 * frames, each frame holding a run of JSONL events.
 *
 * Faithful port of the decoder shipped in `dsh-workbuddy-quota@0.2.0` (the
 * predecessor package). The fold is only as trustworthy as its input, so this
 * deliberately keeps the predecessor's behaviour, including its fallback: a log
 * with no zstd magic at all is read as plain UTF-8 rather than treated as
 * unreadable.
 */

import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decode a whole session log.
 *
 * Frames are located by scanning for the zstd magic rather than by trusting a
 * single header: DSH appends frames, and the magic can also occur *inside*
 * compressed payload bytes, so a frame that fails to decompress is skipped
 * instead of aborting the file — losing one frame is a smaller error than
 * losing the session.
 */
export function decodeSessionLog(bytes) {
  const starts = [];
  let index = bytes.indexOf(ZSTD_MAGIC);
  while (index !== -1) {
    starts.push(index);
    index = bytes.indexOf(ZSTD_MAGIC, index + 1);
  }
  if (starts.length === 0) return bytes.toString('utf8');

  let text = '';
  for (let frame = 0; frame < starts.length; frame++) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : bytes.length;
    try {
      text += zstdDecompressSync(bytes.subarray(starts[frame], end)).toString('utf8');
    } catch {
      /* Not a real frame boundary — the magic matched inside a payload. */
    }
  }
  return text;
}

/**
 * Parse JSONL into the minimal event shape the fold needs.
 *
 * Lines that are not objects, or that lack a string `type` / numeric `seq`, are
 * dropped: DSH's own projection skips exactly those, and inventing a seq for
 * them would silently reorder the log.
 */
export function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const row = parsed;
      if (typeof row['type'] !== 'string' || typeof row['seq'] !== 'number') continue;
      events.push({
        type: row['type'],
        seq: row['seq'],
        ...(typeof row['time'] === 'number' ? { time: row['time'] } : {}),
        ...(row['data'] === undefined ? {} : { data: row['data'] }),
      });
    } catch {
      /* A truncated tail line is normal while a session is being written. */
    }
  }
  return events;
}
