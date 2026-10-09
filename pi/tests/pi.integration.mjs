import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { SandboxClient } from "../transport.mjs";

// These tests need an already-running sandbox. They neither start containers nor
// call a model provider, and never modify the server's proxy configuration.
const serverUrl = process.env.REMOTE_SANDBOX_PI_TEST_URL ?? process.env.SANDBOX_PI_TEST_URL;
const skip = !serverUrl && "Set REMOTE_SANDBOX_PI_TEST_URL to an existing sandbox server";
const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const piDirectory = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const text = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const largeOutputCommand = `python3 -c 'import sys; sys.stdout.write(("0123456789" * 10 + "\\n") * 800)'`;

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function unusedUrl() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${port}`;
}

async function fixture(callback) {
  const guestDirectory = `/tmp/pi-sandbox-integration-${randomUUID()}`;
  const hostDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-integration-"));
  const client = new SandboxClient({ url: serverUrl, cwd: "/" });
  try {
    const created = await client.exec(`mkdir -- ${quote(guestDirectory)}`);
    assert.equal(created.exitCode, 0, created.stderr.toString());
    assert.equal(await exists(guestDirectory), false, "The fixture must exist only inside the sandbox");
    await callback({ client, guestDirectory, hostDirectory });
  } finally {
    try { await client.exec(`rm -rf -- ${quote(guestDirectory)}`); }
    finally { await rm(hostDirectory, { recursive: true, force: true }); }
  }
}

async function registeredTools(flags, hostDirectory) {
  const { default: register } = await import("../extension.mjs");
  const tools = new Map();
  const handlers = new Map();
  const values = new Map(Object.entries(flags));
  let activeTools;
  register({
    registerFlag(name, options) { if (!values.has(name)) values.set(name, options.default); },
    getFlag(name) { return values.get(name); },
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); },
    setActiveTools(names) { activeTools = names; },
  });
  const context = {
    cwd: hostDirectory,
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
  };
  return {
    tools, handlers, context,
    get activeTools() { return activeTools; },
    execute(name, params, signal, onUpdate) {
      assert.ok(tools.has(name), `Extension did not register ${name}`);
      return tools.get(name).execute(randomUUID(), params, signal, onUpdate, context);
    },
  };
}

function rpcClient(url, guestDirectory, hostDirectory) {
  return new RpcClient({
    cliPath: join(piDirectory, "bundle", "cli.js"),
    cwd: hostDirectory,
    env: { PI_CODING_AGENT_DIR: join(hostDirectory, "agent") },
    args: [
      "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-builtin-tools", "-e", join(extensionDirectory, "index.ts"),
      "--sandbox-url", url, "--sandbox-cwd", guestDirectory,
    ],
  });
}

test("real Pi tool definitions operate only on the running sandbox", { skip, timeout: 60_000 }, async (t) => {
  await fixture(async ({ client, guestDirectory, hostDirectory }) => {
    const extension = await registeredTools({ "sandbox-url": serverUrl, "sandbox-cwd": guestDirectory }, hostDirectory);
    assert.deepEqual([...extension.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);
    await extension.handlers.get("session_start")({ type: "session_start" }, extension.context);
    assert.deepEqual([...extension.activeTools].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    await assert.rejects(extension.execute("powershell", { command: "Write-Output host" }), /unavailable/i);

    await t.test("write, read, and edit use the guest cwd instead of Pi's host cwd", async () => {
      await extension.execute("write", { path: "nested/example.txt", content: "hello guest\nsecond line\n" });
      assert.equal(await exists(join(hostDirectory, "nested")), false);
      assert.match(text(await extension.execute("read", { path: "nested/example.txt" })), /hello guest\nsecond line/);
      await extension.execute("edit", {
        path: "nested/example.txt", edits: [{ oldText: "hello guest", newText: "hello sandbox" }],
      });
      assert.match(text(await extension.execute("read", { path: "nested/example.txt", offset: 1, limit: 1 })), /hello sandbox/);
      const result = await client.exec(`cat -- ${quote(`${guestDirectory}/nested/example.txt`)}`);
      assert.equal(result.stdout.toString(), "hello sandbox\nsecond line\n");
    });

    await t.test("ls, find, and grep see guest-only files", async () => {
      assert.match(text(await extension.execute("ls", { path: "nested" })), /example\.txt/);
      assert.match(text(await extension.execute("find", { pattern: "**/*.txt" })), /nested\/example\.txt/);
      assert.match(text(await extension.execute("grep", { pattern: "hello sandbox", literal: true })), /example\.txt:1:.*hello sandbox/);
    });

    await t.test("bash streams Linux output and uses the guest working directory", async () => {
      const updates = [];
      const result = await extension.execute("bash", {
        command: "printf 'first\\n'; sleep 0.05; uname -s; pwd; printf 'stderr\\n' >&2",
      }, undefined, (update) => updates.push(text(update)));
      assert.match(text(result), /first\nLinux/);
      assert.ok(text(result).includes(guestDirectory));
      assert.match(text(result), /stderr/);
      assert.ok(updates.some((update) => update.includes("first")), "Output should stream before completion");
    });

    await t.test("host-only files cannot be read or edited by the model tools", async () => {
      const hostOnly = join(hostDirectory, "host-only.txt");
      await writeFile(hostOnly, "host sentinel\n");
      await assert.rejects(extension.execute("read", { path: hostOnly }));
      await assert.rejects(extension.execute("edit", {
        path: hostOnly, edits: [{ oldText: "host sentinel", newText: "changed" }],
      }));
      assert.equal(await readFile(hostOnly, "utf8"), "host sentinel\n");
    });

    await t.test("aborting bash cancels instead of waiting for the guest sleep", async () => {
      const controller = new AbortController();
      const result = extension.execute("bash", { command: "printf 'ready\\n'; sleep 30" }, controller.signal,
        (update) => { if (text(update).includes("ready")) controller.abort(); });
      await assert.rejects(result, /abort|cancel/i);
    });

    await t.test("bash honors its per-command timeout", async () => {
      await assert.rejects(extension.execute("bash", { command: "sleep 30", timeout: 0.05 }), /timed out/i);
    });

    await t.test("both ! and !! hooks provide remote operations", async () => {
      for (const excludeFromContext of [false, true]) {
        const command = "uname -s; pwd";
        const hook = extension.handlers.get("user_bash")({
          type: "user_bash", command, cwd: hostDirectory, excludeFromContext,
        }, extension.context);
        assert.equal(typeof hook.operations.exec, "function");
        const chunks = [];
        const result = await hook.operations.exec(command, hostDirectory, { onData(chunk) { chunks.push(chunk); } });
        assert.equal(result.exitCode, 0);
        assert.equal(Buffer.concat(chunks).toString(), `Linux\n${guestDirectory}\n`);
      }
    });

    await t.test("large bash output is saved in the guest", async () => {
      const result = await extension.execute("bash", { command: largeOutputCommand });
      const outputPath = result.details?.fullOutputPath;
      assert.match(outputPath, /^\/tmp\/pi-sandbox-[\da-f-]+\.log$/);
      try {
        assert.equal(result.details.truncation.truncated, true);
        assert.equal(await exists(outputPath), false);
        const size = await client.exec(`wc -c < ${quote(outputPath)}`);
        assert.equal(Number(size.stdout.toString().trim()), 80_800);
      } finally { await client.exec(`rm -f -- ${quote(outputPath)}`); }
    });
  });
});

test("unavailable or invalid sandbox never falls back to host tools", { skip, timeout: 30_000 }, async () => {
  const hostDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-fail-closed-"));
  try {
    for (const url of [await unusedUrl(), "ftp://127.0.0.1/"]) {
      const extension = await registeredTools({ "sandbox-url": url, "sandbox-cwd": "/tmp" }, hostDirectory);
      const marker = join(hostDirectory, `marker-${randomUUID()}`);
      const command = `printf host-executed > ${quote(marker)}`;
      await assert.rejects(extension.execute("bash", { command }));
      await assert.rejects(extension.execute("write", { path: marker, content: "host write" }));
      // Pi catches exceptions from user_bash handlers and then uses its local
      // shell. Therefore the hook itself must successfully return operations.
      const result = await extension.handlers.get("user_bash")({
        type: "user_bash", command, cwd: hostDirectory, excludeFromContext: false,
      }, extension.context);
      assert.equal(typeof result?.operations?.exec, "function");
      await assert.rejects(result.operations.exec(command, hostDirectory, { onData() {} }));
      assert.equal(await exists(marker), false);
    }
  } finally { await rm(hostDirectory, { recursive: true, force: true }); }
});

test("Pi RPC bash uses the real user_bash hook without a model call", { skip, timeout: 60_000 }, async () => {
  await fixture(async ({ client, guestDirectory, hostDirectory }) => {
    const rpc = rpcClient(serverUrl, guestDirectory, hostDirectory);
    try {
      await rpc.start();
      await rpc.getState();
      const result = await rpc.bash("uname -s; pwd; printf rpc-proof > rpc.txt");
      assert.equal(result.exitCode, 0);
      assert.equal(result.cancelled, false);
      assert.ok(result.output.startsWith(`Linux\n${guestDirectory}\n`), result.output);
      const proof = await client.exec(`cat -- ${quote(`${guestDirectory}/rpc.txt`)}`);
      assert.equal(proof.stdout.toString(), "rpc-proof");
      assert.equal(await exists(join(hostDirectory, "rpc.txt")), false);
      assert.doesNotMatch(rpc.getStderr(), /failed to load extension/i);

      const large = await rpc.bash(largeOutputCommand);
      assert.equal(large.exitCode, 0);
      assert.equal(large.fullOutputPath, undefined, "Pi must not write a host overflow file");
      const outputPath = /Full output in sandbox: (\/tmp\/pi-sandbox-[\da-f-]+\.log)/.exec(large.output)?.[1];
      assert.ok(outputPath, large.output.slice(-500));
      try {
        assert.ok(Buffer.byteLength(large.output) < 50 * 1024);
        assert.equal(await exists(outputPath), false);
        const size = await client.exec(`wc -c < ${quote(outputPath)}`);
        assert.equal(Number(size.stdout.toString().trim()), 80_800);
      } finally { await client.exec(`rm -f -- ${quote(outputPath)}`); }
    } finally { await rpc.stop(); }
  });
});

test("Pi RPC user shell fails closed for unavailable and invalid servers", { skip, timeout: 60_000 }, async () => {
  const hostDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-rpc-fail-closed-"));
  const marker = join(hostDirectory, "must-not-exist");
  try {
    for (const url of [await unusedUrl(), "ftp://127.0.0.1/"]) {
      const rpc = rpcClient(url, "/tmp", hostDirectory);
      try {
        await rpc.start();
        await rpc.getState();
        await assert.rejects(rpc.bash(`printf host-executed > ${quote(marker)}`), /sandbox|connect|ECONNREFUSED/i);
        assert.equal(await exists(marker), false);
      } finally { await rpc.stop(); }
    }
  } finally {
    await rm(hostDirectory, { recursive: true, force: true });
  }
});
