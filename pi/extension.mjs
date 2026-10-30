import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createPowerShellToolDefinition,
  createReadToolDefinition, createWriteToolDefinition, truncateHead, truncateTail,
} from "@earendil-works/pi-coding-agent";
import { SandboxClient } from "./transport.mjs";
import { createRemoteOperations, executeGrep, resolveGuestPath } from "./operations.mjs";

const REMOTE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const OUTPUT_CAP = 16 * 1024 * 1024;
const resultText = (text, details = undefined) => ({ content: [{ type: "text", text }], details });

function timeoutMilliseconds(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number) || number <= 0 || number > 300) {
    throw new Error("Sandbox timeout must be greater than 0 and at most 300 seconds.");
  }
  return Math.ceil(number * 1000);
}

function mapGuestPath(value, runtime) {
  if (typeof value !== "string") throw new Error("A file path must be a string.");
  const input = value.startsWith("@") ? value.slice(1) : value;
  // Translate only advertised mounts, on path boundaries; never inspect host files.
  const mount = runtime.mounts.find(({ hostPath }) =>
    input === hostPath || input.startsWith(`${hostPath}/`));
  const mapped = mount ? `${mount.guestPath}${input.slice(mount.hostPath.length)}` : input;
  return resolveGuestPath(mapped, runtime.cwd, runtime.home);
}

/** Collect bounded output; persist overflow in the guest, never a host temp file. */
async function runShell(runtime, command, { signal, timeout, onUpdate, onData } = {}) {
  const chunks = [];
  let bytes = 0;
  let lastUpdate = 0;
  let preview = "";
  let prefixFinished = false;
  const decoder = new TextDecoder();
  let prefixBytes = 0;
  let prefixLines = 0;
  const emitUserPrefix = (text) => {
    if (!onData || prefixFinished) return;
    // Pi's user-shell accumulator otherwise writes host overflow files. Bound
    // what it sees to a streamed prefix plus a final tail and guest log path.
    let visible = "";
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (prefixBytes + size > 16 * 1024 || (character === "\n" && prefixLines >= 400)) {
        prefixFinished = true;
        break;
      }
      visible += character;
      prefixBytes += size;
      if (character === "\n") prefixLines++;
    }
    if (visible) onData(Buffer.from(visible));
  };
  let exit;
  let failure;
  try {
    exit = await runtime.client.exec(command, {
      cwd: runtime.cwd, signal,
      timeoutMs: timeout === undefined ? runtime.timeoutMs : timeoutMilliseconds(timeout),
      onData(data) {
        bytes += data.length;
        if (bytes > OUTPUT_CAP) throw new Error("Sandbox output exceeds 16 MiB.");
        chunks.push(data);
        const decoded = decoder.decode(data, { stream: true });
        emitUserPrefix(decoded);
        if (onUpdate) {
          preview = truncateTail(preview + decoded).content;
          if (Date.now() - lastUpdate >= 100) {
            lastUpdate = Date.now();
            onUpdate(resultText(preview));
          }
        }
      },
    });
  } catch (error) {
    failure = error;
  }
  emitUserPrefix(decoder.decode());
  const buffer = Buffer.concat(chunks);
  const full = buffer.toString("utf8");
  const truncated = truncateTail(full, onData ? { maxBytes: 24 * 1024, maxLines: 1000 } : undefined);
  let fullOutputPath;
  let saveError;
  if (truncated.truncated || prefixFinished) {
    fullOutputPath = `/tmp/pi-sandbox-${randomUUID()}.log`;
    try {
      // The original operation may be aborted. Preserve the already received
      // output using a separate, short, remote-only write.
      const logClient = { exec: (cmd, options) => runtime.client.exec(cmd, { ...options, timeoutMs: 5000 }) };
      await createRemoteOperations(logClient, runtime).writeOps.writeFile(fullOutputPath, buffer);
    } catch (error) {
      fullOutputPath = undefined;
      saveError = `Could not save sandbox output: ${error.message}`;
    }
  }
  const notice = fullOutputPath ? `Full output in sandbox: ${fullOutputPath}` : saveError;
  if (onData && prefixFinished) {
    onData(Buffer.from(`\n\n[Output abbreviated; final output follows]\n${truncated.content}\n\n[${notice || "Output truncated"}]\n`));
  }
  let text = truncated.content || "(no output)";
  if (notice) text += `\n\n[${notice}]`;
  const details = truncated.truncated ? { truncation: truncated, fullOutputPath } : undefined;
  if (failure) {
    const error = new Error(`${failure.message}${full ? `\n\n${text}` : ""}`, { cause: failure });
    error.name = signal?.aborted ? "AbortError" : "Error";
    throw error;
  }
  if (exit.exitCode !== 0) text += `\n\nCommand exited with code ${exit.exitCode}`;
  return { ...resultText(text, details), exitCode: exit.exitCode };
}

async function readFileTool(runtime, params, signal, ctx) {
  const file = mapGuestPath(params.path, runtime);
  const { readOps } = createRemoteOperations(runtime.client, { ...runtime, signal });
  await readOps.access(file);
  const mime = await readOps.detectImageMimeType(file);
  const data = await readOps.readFile(file);
  if (mime) {
    if (ctx?.model && !ctx.model.input.includes("image")) {
      return resultText(`Image ${file} (${mime}); the current model does not support images.`);
    }
    return { content: [{ type: "text", text: `Read image file [${mime}]` },
      { type: "image", mimeType: mime, data: data.toString("base64") }], details: undefined };
  }
  const lines = data.toString("utf8").split("\n");
  const offset = params.offset ?? 1;
  const limit = params.limit;
  if (!Number.isInteger(offset) || offset < 1 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) {
    throw new Error("Read offset and limit must be positive integers.");
  }
  if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines).`);
  const selected = lines.slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("\n");
  const truncation = truncateHead(selected);
  let text = truncation.content;
  if (truncation.firstLineExceedsLimit) {
    text = `Line ${offset} exceeds the 50 KiB read limit. Use bash to inspect a bounded portion of this line.`;
  } else if (truncation.truncated) {
    text += `\n\n[Output truncated. Continue with offset=${offset + truncation.outputLines}.]`;
  } else if (limit !== undefined && offset - 1 + limit < lines.length) {
    text += `\n\n[More lines available. Continue with offset=${offset + limit}.]`;
  }
  return resultText(text, truncation.truncated ? { truncation } : undefined);
}

export default function registerSandboxExtension(pi, { Client = SandboxClient } = {}) {
  pi.registerFlag("sandbox-url", { description: "External Sandbox server URL", type: "string", default: "http://127.0.0.1:8687" });
  pi.registerFlag("sandbox-cwd", { description: "Absolute working directory inside the sandbox", type: "string" });
  pi.registerFlag("sandbox-timeout", { description: "Default command timeout in seconds (maximum 300)", type: "string", default: "120" });
  let runtimePromise;
  const active = new Set();
  const runtime = () => {
    if (!runtimePromise) {
      runtimePromise = (async () => {
        const timeoutMs = timeoutMilliseconds(pi.getFlag("sandbox-timeout") ?? "120");
        const url = pi.getFlag("sandbox-url") ?? "http://127.0.0.1:8687";
        const client = new Client({ url, timeoutMs, maxOutputBytes: OUTPUT_CAP });
        const health = await client.health();
        const cwd = pi.getFlag("sandbox-cwd") || health.defaultCwd;
        if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.includes("\0")) {
          throw new Error("--sandbox-cwd must be an absolute guest directory.");
        }
        const probe = await client.exec("printf '%s' \"$HOME\"", { cwd, timeoutMs: 5000 });
        if (probe.exitCode !== 0) throw new Error(`Sandbox working directory is unavailable: ${cwd}`);
        const home = probe.stdout.toString("utf8");
        if (!home.startsWith("/") || home.includes("\0")) throw new Error("Sandbox returned an invalid HOME.");
        const mounts = (health.mounts ?? []).filter(m => typeof m.hostPath === "string" && typeof m.guestPath === "string")
          .sort((a, b) => b.hostPath.length - a.hostPath.length);
        return { client, cwd: path.posix.normalize(cwd), home, timeoutMs, mounts, url };
      })().catch(error => { runtimePromise = undefined; throw error; });
    }
    return runtimePromise;
  };
  const run = async (signal, callback) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    active.add(controller);
    try {
      if (controller.signal.aborted) throw new Error("Operation aborted");
      const config = await runtime();
      if (controller.signal.aborted) throw new Error("Operation aborted");
      return await callback(config, controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      active.delete(controller);
    }
  };

  // In Pi 0.85.1 exceptions in the hook itself may allow local execution.
  // This callback MUST stay synchronous and unconditionally return operations.
  const userOperations = {
    exec: (command, _hostCwd, { onData, signal, timeout } = {}) =>
      run(signal, async (config, signal) => {
        const result = await runShell(config, command, { onData, signal, timeout });
        return { exitCode: result.exitCode };
      }),
  };
  pi.on("user_bash", () => ({ operations: userOperations }));

  const factories = { edit: createEditToolDefinition, write: createWriteToolDefinition,
    ls: createLsToolDefinition, find: createFindToolDefinition };
  for (const [name, factory] of Object.entries(factories)) {
    pi.registerTool({ ...factory("/"),
      execute: (id, params, signal, onUpdate, ctx) => run(signal, async (config, signal) => {
        const operations = createRemoteOperations(config.client, { ...config, signal });
        const tool = factory(config.cwd, { operations: operations[`${name}Ops`] });
        return tool.execute(id, { ...params, path: mapGuestPath(params.path ?? ".", config) }, signal, onUpdate,
          ctx ? { ...ctx, cwd: config.cwd } : undefined);
      }),
    });
  }
  pi.registerTool({ ...createReadToolDefinition("/"),
    description: "Read text or images inside the sandbox. Text is limited to 2000 lines or 50 KiB; use offset and limit for more. Images are returned without resizing. Maximum file size is just under 12 MiB.",
    execute: (_id, params, signal, _onUpdate, ctx) => run(signal, (config, signal) => readFileTool(config, params, signal, ctx)),
  });
  pi.registerTool({ ...createGrepToolDefinition("/"),
    execute: (_id, params, signal) => run(signal, (config, signal) =>
      executeGrep(config.client, { ...params, path: mapGuestPath(params.path ?? ".", config) }, { ...config, signal })),
  });
  pi.registerTool({ ...createBashToolDefinition("/", { exposeSessionEnvironment: false }),
    description: "Run Bash inside the sandbox, streaming stdout and stderr. Default timeout is --sandbox-timeout (120 seconds); maximum 300 seconds. Output cap is 16 MiB. Display the last 2000 lines or 50 KiB; full output is saved inside the sandbox when truncated.",
    execute: (_id, params, signal, onUpdate) => run(signal, async (config, signal) => {
      const result = await runShell(config, params.command, { signal, timeout: params.timeout, onUpdate });
      if (result.exitCode !== 0) throw new Error(result.content[0].text);
      return result;
    }),
  });
  // Register a rejection too, so enabling this built-in later cannot expose a host shell.
  pi.registerTool({ ...createPowerShellToolDefinition("/"),
    execute: async () => { throw new Error("PowerShell is unavailable in this Linux sandbox. Use bash."); },
  });
  pi.on("tool_call", event => {
    if (!REMOTE_TOOLS.includes(event.toolName)) {
      return { block: true, reason: `Tool ${event.toolName} is not routed to the sandbox.` };
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    pi.setActiveTools(REMOTE_TOOLS);
    try {
      const config = await runtime();
      ctx.ui.setStatus("sandbox", `Sandbox: ${config.url} · ${config.cwd}`);
    } catch (error) {
      ctx.ui.setStatus("sandbox", "Sandbox unavailable");
      ctx.ui.notify(`Sandbox unavailable: ${error.message}. Tools will fail until it is reachable.`, "error");
    }
  });
  pi.on("session_shutdown", () => {
    for (const controller of active) controller.abort();
    runtimePromise = undefined;
  });
  pi.on("before_agent_start", async event => {
    const config = await runtime();
    const prompt = event.systemPrompt.replace(/^Current working directory:.*$/m, `Current working directory: ${config.cwd}`);
    return { systemPrompt: `${prompt}\n\nAll coding tools execute in a Linux sandbox via ${config.url}. Working directory: ${config.cwd}. Home: ${config.home}. Absolute paths refer to the guest filesystem. Each bash command starts a fresh shell. Network access follows the sandbox server's proxy policy. Do not use host paths except advertised mounted paths.` };
  });
}
