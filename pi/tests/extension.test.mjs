import assert from "node:assert/strict";
import test from "node:test";
import register from "../extension.mjs";

function extension({ flags = {}, output = [Buffer.from("hello\n")], exitCode = 0, fail = false, mounts = [] } = {}) {
  const tools = new Map(), hooks = new Map(), requests = [], files = new Map();
  let active;
  class Client {
    constructor(config) { this.config = config; }
    async health() {
      if (fail) throw new Error("Cannot connect to sandbox");
      return { status: "ready", defaultCwd: "/workspace", mounts };
    }
    async exec(command, options) {
      requests.push({ command, ...options });
      if (command === "printf '%s' \"$HOME\"") return { stdout: Buffer.from("/home/agent"), exitCode: 0 };
      if (options.stdin) {
        const request = JSON.parse(options.stdin);
        if (request.operation === "write") files.set(request.path, Buffer.from(request.data, "base64"));
        if (request.operation === "read" && !files.has(request.path)) throw new Error(`ENOENT: ${request.path}`);
        const value = request.operation === "read" ? files.get(request.path).toString("base64") : null;
        return { stdout: Buffer.from(JSON.stringify({ ok: true, value })), stderr: Buffer.alloc(0), exitCode: 0 };
      }
      for (const chunk of output) options.onData?.(chunk, "stdout");
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode };
    }
  }
  register({
    registerFlag(name, options) { if (!(name in flags)) flags[name] = options.default; },
    getFlag: name => flags[name], registerTool: tool => tools.set(tool.name, tool),
    on: (name, callback) => hooks.set(name, callback), setActiveTools: names => { active = names; },
  }, { Client });
  const ctx = { cwd: "/host/project", ui: { setStatus() {}, notify() {} } };
  return { tools, hooks, files, requests, ctx, active: () => active,
    exec: (name, params, signal, onUpdate) => tools.get(name).execute("test", params, signal, onUpdate, ctx) };
}

test("user shell hook is synchronous and always returns the same remote backend", async () => {
  for (const flags of [{ "sandbox-timeout": "invalid" }, {}]) {
    const api = extension({ flags, fail: true });
    const first = api.hooks.get("user_bash")({ excludeFromContext: false });
    const second = api.hooks.get("user_bash")({ excludeFromContext: true });
    assert.equal(typeof first.then, "undefined");
    assert.equal(first.operations, second.operations);
    await assert.rejects(first.operations.exec("echo hi", "/host", {}), /timeout|connect/i);
  }
});

test("agent nonzero exits are errors; manual commands preserve their exit status", async () => {
  const api = extension({ exitCode: 7 });
  await assert.rejects(api.exec("bash", { command: "exit 7" }), /hello\s+Command exited with code 7/);
  const hook = api.hooks.get("user_bash")({});
  assert.deepEqual(await hook.operations.exec("exit 7", "/host", { onData() {} }), { exitCode: 7 });
});

test("remote shell ignores host cwd and environment, and converts timeout seconds", async () => {
  const api = extension();
  const hook = api.hooks.get("user_bash")({});
  await hook.operations.exec("pwd", "/host/secrets", { timeout: 2, env: { API_KEY: "secret" }, onData() {} });
  const request = api.requests.at(-1);
  assert.equal(request.cwd, "/workspace");
  assert.equal(request.timeoutMs, 2000);
  assert.equal(request.env, undefined);
  await assert.rejects(api.exec("bash", { command: "pwd", timeout: 301 }), /at most 300/);
});

test("large command output is saved remotely and both output modes stay bounded", async () => {
  const output = Buffer.from("😀 sample\n".repeat(10000));
  const api = extension({ output: [output.subarray(0, 2), output.subarray(2)] });
  const result = await api.exec("bash", { command: "large" });
  const guestLog = result.details.fullOutputPath;
  assert.match(guestLog, /^\/tmp\/pi-sandbox-/);
  assert.deepEqual(api.files.get(guestLog), output);
  const streamed = [];
  await api.hooks.get("user_bash")({}).operations.exec("large", "/host", { onData: bytes => streamed.push(bytes) });
  const visible = Buffer.concat(streamed).toString("utf8");
  assert.ok(Buffer.byteLength(visible) < 50 * 1024);
  assert.ok(visible.split("\n").length < 2000);
  assert.ok(visible.startsWith("😀 sample\n"));
  assert.ok(!visible.includes("�"));
  assert.match(visible, /Full output in sandbox: \/tmp\/pi-sandbox-/);
  assert.equal(api.files.size, 2);
});

test("read paths resolve guest home and only translate advertised mount boundaries", async () => {
  const api = extension({ mounts: [{ hostPath: "/host/project", guestPath: "/mnt/project" }] });
  api.files.set("/mnt/project/file.txt", Buffer.from("mounted"));
  api.files.set("/home/agent/file.txt", Buffer.from("home"));
  assert.equal((await api.exec("read", { path: "/host/project/file.txt" })).content[0].text, "mounted");
  assert.equal((await api.exec("read", { path: "~/file.txt" })).content[0].text, "home");
  await assert.rejects(api.exec("read", { path: "/host/project-other/file.txt" }), /ENOENT: \/host\/project-other/);
});

test("session setup advertises the sandbox, restricts tools, and disables PowerShell", async () => {
  const api = extension();
  await api.hooks.get("session_start")({}, api.ctx);
  assert.deepEqual(api.active(), ["read", "bash", "edit", "write", "grep", "find", "ls"]);
  assert.ok(api.hooks.get("tool_call")({ toolName: "host_command" }).block);
  assert.equal(api.hooks.get("tool_call")({ toolName: "bash" }), undefined);
  await assert.rejects(api.exec("powershell", { command: "pwd" }), /unavailable/);
  const result = await api.hooks.get("before_agent_start")({ systemPrompt: "Current working directory: /host/project" });
  assert.match(result.systemPrompt, /Current working directory: \/workspace/);
  assert.ok(!result.systemPrompt.includes("/host/project"));
});

test("unavailable startup keeps tools remote and already aborted calls never execute", async () => {
  const api = extension({ fail: true });
  await api.hooks.get("session_start")({}, api.ctx);
  await assert.rejects(api.exec("bash", { command: "pwd" }), /connect/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.exec("bash", { command: "pwd" }, controller.signal), /aborted/);
  assert.equal(api.requests.length, 0);
});
