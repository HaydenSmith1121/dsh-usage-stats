/**
 * FROZEN REFERENCE — the fold as shipped in `dsh-workbuddy-quota@0.2.0`.
 *
 * This file is machine-extracted from the published artifact, not retyped:
 *
 *   source : dsh-workbuddy-quota-0.2.0.tgz
 *            sha256 744a39879202782bdbca4d8235094949b73accf7c2f0153841872aed2d2388f8
 *            (also snapshotted at snapshots/dsh-workbuddy-quota/0.2.0/ in
 *             HaydenSmith1121/dsh-plugin-collection)
 *   extracted: everything above the plugin entry point in package/lib/index.js,
 *            plus an explicit export list. No logic was edited.
 *
 * It exists so `scripts/verify-fold.mjs` can prove, on any machine and
 * offline, that the 0.3.0 fold still agrees with the 0.2.0 fold it replaced —
 * the numbers users already saw must not move. When a real 0.2.0 tarball is
 * available, pass `--reference <extracted package dir>` and the script will
 * prefer that artifact over this copy.
 */
// src/index.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/usage-host.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// src/usage-types.ts
function localDayKey(time) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

// src/usage-fold.ts
function zeroMutable() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
function isZero(buckets) {
  return buckets.uncachedInputTokens === 0 && buckets.outputTokens === 0 && buckets.cacheReadTokens === 0 && buckets.cacheWriteTokens === 0;
}
function bucketsFrom(usage) {
  return {
    uncachedInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0
  };
}
function bucketsEqual(left, right) {
  return left.uncachedInputTokens === right.uncachedInputTokens && left.outputTokens === right.outputTokens && left.cacheReadTokens === right.cacheReadTokens && left.cacheWriteTokens === right.cacheWriteTokens;
}
function isUsage(value) {
  if (typeof value !== "object" || value === null) return false;
  const row = value;
  return typeof row["inputTokens"] === "number" && typeof row["outputTokens"] === "number";
}
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return void 0;
  let found;
  for (const entry of stream) {
    if (typeof entry !== "object" || entry === null) continue;
    const chunk = entry["chunk"];
    if (typeof chunk !== "object" || chunk === null) continue;
    const row = chunk;
    if (row["type"] !== "usage") continue;
    if (isUsage(row["usage"])) found = row["usage"];
  }
  return found;
}
function usageOf(event) {
  const data = event.data;
  if (typeof data !== "object" || data === null) return void 0;
  const row = data;
  if (event.type === "assistant/message") {
    return isUsage(row["usage"]) ? row["usage"] : void 0;
  }
  if (event.type !== "assistant/attempt") return void 0;
  return lastStreamUsage(row["stream"]);
}
function stepOf(event) {
  const data = event.data;
  if (typeof data !== "object" || data === null) return void 0;
  const row = data;
  const turn = row["turn"];
  const step = row["step"];
  if (typeof turn !== "number" || typeof step !== "number") return void 0;
  return `${String(turn)}:${String(step)}`;
}
function routeOf(event) {
  const data = event.data;
  if (typeof data !== "object" || data === null) return void 0;
  const message = data["message"];
  if (typeof message !== "object" || message === null) return void 0;
  const source = message["source"];
  if (typeof source !== "object" || source === null) return void 0;
  const sourceRow = source;
  const provider = sourceRow["provider"];
  if (typeof provider !== "string") return void 0;
  const model = sourceRow["model"];
  return { provider, model: typeof model === "string" ? model : "" };
}
function foldSession(events, inheritedEventCount, fallbackTime) {
  const slots = /* @__PURE__ */ new Map();
  let last = null;
  let clock = fallbackTime;
  let route = { provider: "", model: "" };
  let fullyDated = true;
  for (const event of events) {
    if (event.seq < inheritedEventCount) continue;
    const dated = typeof event.time === "number" && Number.isFinite(event.time);
    if (dated) clock = event.time;
    if (event.type === "llm/retry-started") {
      const step2 = stepOf(event);
      if (step2 !== void 0 && last !== null && last.step === step2) last = null;
      continue;
    }
    const sample = usageOf(event);
    if (sample === void 0) continue;
    const step = stepOf(event);
    if (step === void 0) continue;
    const buckets = bucketsFrom(sample);
    const previous = last !== null && last.step === step ? last.buckets : void 0;
    if (previous !== void 0 && bucketsEqual(previous, buckets)) continue;
    if (!dated) fullyDated = false;
    const eventRoute = routeOf(event);
    if (eventRoute !== void 0) route = eventRoute;
    let stepSlots = slots.get(step);
    if (stepSlots === void 0) {
      stepSlots = [];
      slots.set(step, stepSlots);
    }
    let index;
    if (previous !== void 0 && last !== null) {
      index = last.index;
      stepSlots[index] = { buckets, time: clock, provider: route.provider, model: route.model };
    } else {
      stepSlots.push({ buckets, time: clock, provider: route.provider, model: route.model });
      index = stepSlots.length - 1;
    }
    last = { step, index, buckets };
  }
  const cells = /* @__PURE__ */ new Map();
  let attempts = 0;
  for (const stepSlots of slots.values()) {
    for (const slot of stepSlots) {
      if (isZero(slot.buckets)) continue;
      attempts++;
      const day = localDayKey(slot.time);
      const key = `${day}\0${slot.provider}\0${slot.model}`;
      let cell = cells.get(key);
      if (cell === void 0) {
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
        cacheWriteTokens: cell.buckets.cacheWriteTokens
      },
      attempts: cell.attempts
    });
  }
  return { cells: out, attempts, fullyDated };
}
function mergeCells(into, cells) {
  for (const cell of cells) {
    const key = `${cell.day}\0${cell.provider}\0${cell.model}`;
    const existing = into.get(key);
    if (existing === void 0) {
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
        cacheWriteTokens: existing.buckets.cacheWriteTokens + cell.buckets.cacheWriteTokens
      },
      attempts: existing.attempts + cell.attempts
    });
  }
}

// src/usage-host.ts
var ZSTD_MAGIC = Buffer.from([40, 181, 47, 253]);
var SESSION_FILE = "session.v3.jsonl.zstd";
var CACHE_TTL_MS = 15e3;
var USAGE_ROUTE = "/plugins/dsh-workbuddy-quota/usage";
function decodeSessionLog(bytes) {
  const starts = [];
  let index = bytes.indexOf(ZSTD_MAGIC);
  while (index !== -1) {
    starts.push(index);
    index = bytes.indexOf(ZSTD_MAGIC, index + 1);
  }
  if (starts.length === 0) return bytes.toString("utf8");
  let text = "";
  for (let frame = 0; frame < starts.length; frame++) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : bytes.length;
    try {
      text += zstdDecompressSync(bytes.subarray(starts[frame], end)).toString("utf8");
    } catch {
    }
  }
  return text;
}
function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      const row = parsed;
      if (typeof row["type"] !== "string" || typeof row["seq"] !== "number") continue;
      events.push({
        type: row["type"],
        seq: row["seq"],
        ...typeof row["time"] === "number" ? { time: row["time"] } : {},
        ...row["data"] === void 0 ? {} : { data: row["data"] }
      });
    } catch {
    }
  }
  return events;
}
function foldLog(text) {
  const events = parseEvents(text);
  const header = events.find((event) => event.type === "session");
  const headerData = header?.data;
  const row = typeof headerData === "object" && headerData !== null ? headerData : {};
  const inherited = typeof row["inheritedEventCount"] === "number" ? row["inheritedEventCount"] : 0;
  const createdAt = typeof row["createdAt"] === "number" ? row["createdAt"] : 0;
  return foldSession(events, inherited, createdAt).cells;
}
async function scanSessions(sessionsRoot) {
  const merged = /* @__PURE__ */ new Map();
  let scannedSessions = 0;
  let failedSessions = 0;
  let workspaces;
  try {
    workspaces = await readdir(sessionsRoot);
  } catch {
    return { cells: [], scannedSessions: 0, failedSessions: 0 };
  }
  for (const workspace of workspaces) {
    const workspacePath = join(sessionsRoot, workspace);
    let sessions;
    try {
      if (!(await stat(workspacePath)).isDirectory()) continue;
      sessions = await readdir(workspacePath);
    } catch {
      failedSessions++;
      continue;
    }
    for (const session of sessions) {
      const sessionPath = join(workspacePath, session);
      try {
        if (!(await stat(sessionPath)).isDirectory()) continue;
        const bytes = await readFile(join(sessionPath, SESSION_FILE));
        mergeCells(merged, foldLog(decodeSessionLog(bytes)));
        scannedSessions++;
      } catch {
        failedSessions++;
      }
    }
  }
  return { cells: [...merged.values()], scannedSessions, failedSessions };
}
var ScanCache = class {
  constructor(root, ttlMs = CACHE_TTL_MS) {
    this.root = root;
    this.ttlMs = ttlMs;
  }
  value;
  inFlight;
  /**
   * The current report, rescanning at most once per TTL.
   *
   * Concurrent callers share one scan: several browser tabs opening the page
   * together must not multiply the work.
   *
   * @returns the assembled report.
   */
  async report() {
    const now = Date.now();
    if (this.value !== void 0 && now - this.value.at < this.ttlMs) return assemble(this.value.result, this.value.at);
    this.inFlight ??= this.scan(now).finally(() => {
      this.inFlight = void 0;
    });
    const scanned = await this.inFlight;
    return assemble(scanned, this.value?.at ?? now);
  }
  async scan(now) {
    const result = await scanSessions(this.root);
    this.value = { at: now, result };
    return result;
  }
};
function assemble(result, generatedAt) {
  return {
    generatedAt,
    scannedSessions: result.scannedSessions,
    failedSessions: result.failedSessions,
    cells: result.cells
  };
}
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    /* A header value is a string on the wire; a bare number would be coerced
       by node today but is not what the contract says. */
    "content-length": String(Buffer.byteLength(text))
  });
  res.end(text);
}
function loopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function usageHandler(cache) {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (!loopbackRequest(req)) {
      writeJson(res, 403, { error: "request-not-trusted" });
      return;
    }
    try {
      writeJson(res, 200, await cache.report());
    } catch (error) {
      writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
function createScanCache(sessionsRoot) {
  return new ScanCache(sessionsRoot);
}

export { foldLog, foldSession, scanSessions, decodeSessionLog, parseEvents, localDayKey, mergeCells };

