import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

function integer(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function guestPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) {
    throw new Error("Sandbox cwd must be an absolute guest path.");
  }
  return value;
}

function abortError() {
  const error = new Error("Sandbox execution aborted.");
  error.name = "AbortError";
  return error;
}

function decodeOutput(value) {
  if (typeof value !== "string") throw new Error("Sandbox output must contain base64 data.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Sandbox output contains invalid base64 data.");
  return decoded;
}

function executionResult(frame) {
  const code = frame.exitCode;
  const signal = frame.signal;
  if (!(code === null || (Number.isInteger(code) && code >= 0 && code <= 255))
      || !(signal === null || (Number.isInteger(signal) && signal >= 1 && signal <= 127))
      || typeof frame.timedOut !== "boolean" || typeof frame.outputLimitExceeded !== "boolean") {
    throw new Error("Sandbox returned an invalid execution result.");
  }
  if (frame.timedOut) throw new Error("Sandbox command timed out.");
  if (frame.outputLimitExceeded) throw new Error("Sandbox command exceeded its output limit.");
  if (code === null && signal === null) throw new Error("Sandbox returned neither an exit code nor a signal.");
  return { exitCode: signal === null ? code : 128 + signal, timedOut: false, outputLimitExceeded: false };
}

/** Direct, originless client for the v86-compatible shell API. Never executes host commands. */
export class SandboxClient {
  constructor({ url, cwd, timeoutMs = 120_000, maxOutputBytes = MAX_OUTPUT_BYTES }) {
    this.url = new URL(url);
    if (!["http:", "https:"].includes(this.url.protocol)
        || this.url.username || this.url.password || this.url.search || this.url.hash
        || this.url.pathname !== "/") {
      throw new Error("Sandbox URL must be an http(s) origin without credentials, a path, query, or fragment.");
    }
    this.cwd = cwd === undefined ? undefined : guestPath(cwd);
    this.timeoutMs = integer(timeoutMs, "timeoutMs", 300_000);
    this.maxOutputBytes = integer(maxOutputBytes, "maxOutputBytes", MAX_OUTPUT_BYTES);
  }

  /** Fetch fresh health metadata. HTTP proxy environment variables and redirects are not used. */
  async health({ signal } = {}) {
    if (signal?.aborted) throw abortError();
    const url = new URL("/health", this.url);
    const body = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let request;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) {
          request?.destroy();
          reject(error);
        } else resolve(result);
      };
      const onAbort = () => finish(abortError());
      request = (url.protocol === "https:" ? https : http).get(url, {
        agent: false,
        headers: { Accept: "application/json" },
      }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          finish(new Error(`Sandbox /health returned HTTP ${response.statusCode}.`));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > 256 * 1024) {
            finish(new Error("Sandbox /health response exceeds 256 KiB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (error) => finish(new Error(`Sandbox /health failed: ${error.message}`, { cause: error })));
        response.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", (error) => finish(new Error(`Cannot connect to sandbox: ${error.message}`, { cause: error })));
      timer = setTimeout(() => finish(new Error("Sandbox /health request timed out.")), CONNECT_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    let data;
    try { data = JSON.parse(body); } catch { throw new Error("Sandbox /health returned invalid JSON."); }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.status !== "ready") {
      throw new Error("Sandbox server is not ready.");
    }
    guestPath(data.defaultCwd);
    return data;
  }

  /**
   * Run one command. onData receives (Buffer, "stdout" | "stderr") synchronously;
   * streamed bytes are not also accumulated. stdin is bounded to one acknowledged
   * 32 KiB chunk in flight. Nonzero command exits are normal results.
   */
  async exec(command, { cwd, stdin, signal, timeoutMs = this.timeoutMs, onData } = {}) {
    if (signal?.aborted) throw abortError();
    if (typeof command !== "string" || !command.trim() || command.includes("\0")
        || Buffer.byteLength(command) > 64 * 1024) {
      throw new Error("Sandbox command must be a nonempty string of at most 64 KiB without NUL bytes.");
    }
    integer(timeoutMs, "timeoutMs", 300_000);
    if (stdin !== undefined && !Buffer.isBuffer(stdin) && typeof stdin !== "string") {
      throw new Error("Sandbox stdin must be a Buffer or string.");
    }
    if (onData !== undefined && typeof onData !== "function") throw new Error("onData must be a function.");
    const input = stdin === undefined ? undefined : Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin);
    const directory = guestPath(cwd ?? this.cwd ?? (await this.health({ signal })).defaultCwd);
    if (signal?.aborted) throw abortError();
    const url = new URL("/exec/ws", this.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        handshakeTimeout: CONNECT_TIMEOUT_MS,
        maxPayload: 256 * 1024,
        perMessageDeflate: false,
        followRedirects: false,
      });
      let settled = false;
      let started = false;
      let inputClosed = false;
      let inputOffset = 0;
      let sequence = 0;
      let pendingAck = null;
      let eofSent = false;
      let size = 0;
      const stdout = [];
      const stderr = [];
      let closeTimer;
      const deadline = setTimeout(() => finish(new Error("Sandbox stopped responding before its execution deadline.")), timeoutMs + CONNECT_TIMEOUT_MS);

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onAbort);
        if (socket.readyState === WebSocket.OPEN) {
          if (error) socket.send(JSON.stringify({ type: "cancel" }), () => {});
          socket.close();
          closeTimer = setTimeout(() => socket.terminate(), 250);
          closeTimer.unref();
        } else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        if (error) reject(error);
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), ...result });
      };
      const send = (frame) => {
        if (settled) return;
        socket.send(JSON.stringify(frame), (error) => {
          if (error) finish(new Error(`Sandbox connection failed: ${error.message}`, { cause: error }));
        });
      };
      const pumpInput = () => {
        if (settled || !started || input === undefined || inputClosed || pendingAck !== null || eofSent) return;
        if (inputOffset === input.length) {
          eofSent = true;
          send({ type: "stdin_eof" });
          return;
        }
        const chunk = input.subarray(inputOffset, inputOffset + CHUNK_BYTES);
        inputOffset += chunk.length;
        pendingAck = sequence++;
        send({ type: "stdin", id: pendingAck, data: chunk.toString("base64") });
      };
      const onAbort = () => finish(abortError());

      socket.on("open", () => {
        if (settled) return;
        send({ type: "start", command, cwd: directory, stdin: input !== undefined, timeoutMs, maxOutputBytes: this.maxOutputBytes });
      });
      socket.on("message", (raw, binary) => {
        if (settled) return;
        try {
          if (binary) throw new Error("Sandbox returned a binary WebSocket message.");
          let frame;
          try { frame = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Sandbox returned invalid JSON."); }
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Sandbox returned an invalid WebSocket message.");
          if (frame.type === "error") throw new Error(`Sandbox API error: ${typeof frame.error === "string" ? frame.error : "unknown error"}`);
          if (frame.type === "started") {
            if (started) throw new Error("Sandbox sent duplicate started messages.");
            started = true;
            pumpInput();
            return;
          }
          if (!started) throw new Error("Sandbox sent a message before started.");
          switch (frame.type) {
            case "stdout":
            case "stderr": {
              const data = decodeOutput(frame.data);
              size += data.length;
              if (size > this.maxOutputBytes) throw new Error("Sandbox command exceeded its output limit.");
              if (onData) onData(data, frame.type);
              else (frame.type === "stdout" ? stdout : stderr).push(data);
              break;
            }
            case "stdin_ack":
              if (!Number.isSafeInteger(frame.id) || pendingAck === null || frame.id !== pendingAck) {
                throw new Error("Sandbox sent an unexpected stdin acknowledgement.");
              }
              pendingAck = null;
              pumpInput();
              break;
            case "stdin_closed":
              if (input === undefined || inputClosed) throw new Error("Sandbox sent an unexpected stdin_closed message.");
              inputClosed = true;
              pendingAck = null;
              break;
            case "exit":
              finish(null, executionResult(frame));
              break;
            default:
              throw new Error(`Sandbox sent an unknown message type: ${String(frame.type)}.`);
          }
        } catch (error) { finish(error); }
      });
      socket.on("error", (error) => finish(new Error(`Sandbox connection failed: ${error.message}`, { cause: error })));
      socket.on("close", (code) => {
        clearTimeout(closeTimer);
        finish(new Error(`Sandbox disconnected without an exit result (WebSocket ${code}).`));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
