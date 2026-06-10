import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const DEFAULT_STDIN_TIMEOUT_MS = 2000;

/**
 * Read piped stdin without ever hanging the process (#7).
 *
 * The earlier implementation defaulted to a SYNCHRONOUS `fs.readFileSync(0)`,
 * which is a lie: a synchronous syscall cannot be interrupted by a JS timeout,
 * so it deadlocks the whole process when stdin is open but never closes (the
 * exact failure in upstream openai/codex-plugin-cc#247) and can crash on EAGAIN
 * when fd 0 is non-blocking under concurrent Claude sessions.
 *
 * The default path now reads fd 0 ASYNCHRONOUSLY by consuming the stdin stream
 * ('data'/'end' events) raced against a timer. It resolves the accumulated
 * payload on 'end', resolves "" on timeout (an open, silent pipe) or stream
 * error (EAGAIN-class included), and never performs a synchronous fd-0 read.
 *
 * All collaborators are injectable so the behavior is unit-testable:
 *   - isTTY    : short-circuit to "" (no piped input).
 *   - readImpl : OPTIONAL legacy polling reader for unit tests. When supplied it
 *                returns the payload (string/Buffer), `null`/`""` for "no data
 *                right now", or throws EAGAIN; it is polled within the budget.
 *                When omitted, the async stream path above is used.
 *   - stream   : the readable to consume on the default path (defaults to
 *                process.stdin); injectable so the async path is unit-testable.
 *   - timeoutMs: total budget before giving up (returns "" rather than hanging).
 *
 * @param {{
 *   isTTY?: boolean,
 *   readImpl?: () => (string|Buffer|null),
 *   stream?: NodeJS.ReadableStream,
 *   timeoutMs?: number
 * }} [options]
 * @returns {Promise<string>}
 */
export async function readStdinIfPiped(options = {}) {
  const isTTY = options.isTTY ?? process.stdin.isTTY;
  if (isTTY) {
    return "";
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS;

  // Legacy injectable polling reader: kept ONLY for the unit tests that pass an
  // explicit readImpl. The production default path never reaches here.
  if (options.readImpl) {
    return pollReadImpl(options.readImpl, timeoutMs);
  }

  return readStreamWithinBudget(options.stream ?? process.stdin, timeoutMs);
}

/**
 * Consume a readable stream's bytes, racing against a bounded budget. Resolves
 * the UTF-8 payload on 'end', or "" if the budget elapses first (an open but
 * silent pipe) or the stream errors (EAGAIN-class read errors included). Never
 * performs a synchronous fd read and never hangs.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function readStreamWithinBudget(stream, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      // Stop pulling bytes so a still-open pipe does not keep the event loop
      // alive after we have given up.
      try {
        stream.pause?.();
      } catch {
        // ignore — best-effort detach.
      }
      resolve(value);
    };

    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => {
      // EAGAIN/EOF/any read failure: never hang the hook — return what we have.
      finish(Buffer.concat(chunks).toString("utf8"));
    };

    const timer = setTimeout(() => {
      // Budget elapsed on a silent, never-closing pipe. Return whatever (if
      // anything) arrived rather than blocking forever.
      finish(Buffer.concat(chunks).toString("utf8"));
    }, timeoutMs);
    timer.unref?.();

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    try {
      stream.resume?.();
    } catch {
      finish("");
    }
  });
}

/**
 * Legacy polling reader path, retained for unit tests that inject a synchronous
 * `readImpl`. Polls within the budget, treating EAGAIN / null as "no data yet".
 *
 * @param {() => (string|Buffer|null)} readImpl
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function pollReadImpl(readImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let chunk;
    try {
      chunk = readImpl();
    } catch (error) {
      if (error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK")) {
        if (Date.now() >= deadline) {
          return "";
        }
        await delay(20);
        continue;
      }
      return "";
    }

    if (chunk === null || chunk === undefined) {
      if (Date.now() >= deadline) {
        return "";
      }
      await delay(20);
      continue;
    }

    return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
