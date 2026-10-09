import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemoteOperations, executeGrep, GUEST_HELPER, resolveGuestPath } from "../operations.mjs";

function mockClient(value) {
  const calls = [];
  return {
    calls,
    async exec(command, options) {
      calls.push({ command, options, data: JSON.parse(options.stdin) });
      return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: true, value })), stderr: Buffer.alloc(0) };
    },
  };
}

test("paths resolve in the guest namespace without consulting host home", () => {
  assert.equal(resolveGuestPath("a/../b", "/workspace"), "/workspace/b");
  assert.equal(resolveGuestPath("@~/x", "/workspace", "/home/agent"), "/home/agent/x");
  assert.equal(resolveGuestPath("~", "/workspace", "/home/agent"), "/home/agent");
  assert.equal(resolveGuestPath("/Users/simon/x", "/workspace"), "/Users/simon/x");
  assert.equal(resolveGuestPath("x\\y", "/workspace"), "/workspace/x\\y");
  assert.throws(() => resolveGuestPath("x\0y", "/workspace"), /Invalid guest path/);
  assert.throws(() => resolveGuestPath("x", "relative"), /must be absolute/);
});

test("binary read and write use base64 JSON, never shell interpolation", async () => {
  const content = Buffer.from([0, 255, 13, 10, 65]);
  const client = mockClient(content.toString("base64"));
  const { readOps, writeOps } = createRemoteOperations(client, { cwd: "/workspace" });
  const name = "a'\";$(touch HACK)\n.bin";
  assert.deepEqual(await readOps.readFile(name), content);
  await writeOps.writeFile(name, content);
  assert.equal(client.calls[0].data.path, `/workspace/${name}`);
  assert.equal(client.calls[1].data.data, content.toString("base64"));
  assert.ok(!client.calls[0].command.includes(name));
  assert.equal(client.calls[0].command, client.calls[1].command);
  assert.equal(client.calls[1].options.cwd, "/workspace");
  assert.equal(client.calls[1].options.maxOutputBytes, 16 * 1024 * 1024);
});

test("cancellation and guest errors fail without alternate execution", async () => {
  const client = mockClient(null);
  const signal = AbortSignal.abort();
  await assert.rejects(createRemoteOperations(client, { cwd: "/workspace", signal }).readOps.access("x"), /aborted/);
  assert.equal(client.calls.length, 0);
  const missing = { async exec() {
    return { exitCode: 0, stdout: Buffer.from(JSON.stringify({ ok: false, error: "missing", code: "ENOENT" })), stderr: Buffer.alloc(0) };
  } };
  await assert.rejects(createRemoteOperations(missing, { cwd: "/workspace" }).readOps.readFile("x"), { code: "ENOENT" });
  const failed = { async exec() { return { exitCode: 125, stdout: Buffer.alloc(0), stderr: Buffer.from("output limit") }; } };
  await assert.rejects(createRemoteOperations(failed, { cwd: "/workspace" }).readOps.readFile("x"), /output limit/);
  const malformed = { async exec() { return { exitCode: 0, stdout: Buffer.from("{"), stderr: Buffer.alloc(0) }; } };
  await assert.rejects(createRemoteOperations(malformed, { cwd: "/workspace" }).readOps.readFile("x"), /incomplete/);
});

test("grep formats bounded output with Pi result metadata", async () => {
  const client = mockClient({ rows: ["a.txt:1: hello"], matchLimitReached: true, linesTruncated: true });
  const result = await executeGrep(client, { pattern: "hello", limit: 1 }, { cwd: "/workspace" });
  assert.match(result.content[0].text, /^a\.txt:1: hello/);
  assert.equal(result.details.matchLimitReached, 1);
  assert.equal(result.details.linesTruncated, true);
  assert.equal(client.calls[0].data.operation, "grep");
  assert.equal(client.calls[0].data.path, "/workspace");
  const large = mockClient({ rows: Array.from({ length: 200 }, (_, i) => `a:${i}: ${"a".repeat(500)}`) });
  const truncated = await executeGrep(large, { pattern: "." }, { cwd: "/workspace" });
  assert.equal(truncated.details.truncation.truncatedBy, "bytes");
  assert.ok(truncated.details.truncation.outputBytes <= 50 * 1024);
  const empty = await executeGrep(mockClient({ rows: [] }), { pattern: "absent" }, { cwd: "/workspace" });
  assert.equal(empty.content[0].text, "No matches found");
  await assert.rejects(executeGrep(client, { pattern: "x", limit: -1 }, { cwd: "/workspace" }), /limit/);
});

// Validate the exact guest helper against disposable fixtures. The test runner
// invokes Python with uv; production operations.mjs never launches host processes.
function helperClient() {
  return { async exec(_command, options) {
    return new Promise((resolve, reject) => {
      const child = spawn("uv", ["run", "--no-project", "--offline", "python", "-c", GUEST_HELPER], {
        cwd: options.cwd,
        env: { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(tmpdir(), "sandbox-exec-uv-cache") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [], stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      child.stdin.end(options.stdin);
    });
  } };
}

test("guest helper handles binary filenames, stats, images, ignored search and context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-remote-operations-"));
  try {
    const client = helperClient();
    const ops = createRemoteOperations(client, { cwd: directory, home: directory });
    const name = "quote' dollar$(x) newline\n.bin";
    const content = Buffer.from([0, 1, 255, 10, 13]);
    await ops.writeOps.mkdir("nested");
    await ops.writeOps.writeFile(`nested/${name}`, content);
    assert.deepEqual(await ops.readOps.readFile(`nested/${name}`), content);
    assert.equal((await ops.lsOps.stat("nested")).isDirectory(), true);
    assert.deepEqual(await ops.lsOps.readdir("nested"), [name]);
    assert.equal(await ops.lsOps.exists("missing"), false);
    await assert.rejects(ops.readOps.access("missing"), { code: "ENOENT" });
    await ops.writeOps.writeFile("image.bin", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(await ops.readOps.detectImageMimeType("image.bin"), "image/png");
    assert.equal(await ops.readOps.detectImageMimeType(`nested/${name}`), null);
    await writeFile(path.join(directory, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(directory, "ignored.txt"), "needle\n");
    await writeFile(path.join(directory, "visible.txt"), "before\nNeedle\nafter\n");
    await mkdir(path.join(directory, "src"));
    await writeFile(path.join(directory, "src", "main.ts"), "export const value = 1;\n");
    const found = await ops.findOps.glob("*.txt", directory, { ignore: ["**/.git/**"], limit: 100 });
    assert.deepEqual(found, ["visible.txt"]);
    assert.deepEqual(await ops.findOps.glob("src/**/*.ts", directory, { ignore: [], limit: 100 }), ["src/main.ts"]);
    const grep = await executeGrep(client, { pattern: "needle", ignoreCase: true, context: 1 }, { cwd: directory });
    assert.match(grep.content[0].text, /visible\.txt-1- before/);
    assert.match(grep.content[0].text, /visible\.txt:2: Needle/);
    assert.match(grep.content[0].text, /visible\.txt-3- after/);
    assert.doesNotMatch(grep.content[0].text, /ignored/);
    const filtered = await executeGrep(client, { pattern: "needle", ignoreCase: true, glob: "*.txt" }, { cwd: directory });
    assert.match(filtered.content[0].text, /visible\.txt:2: Needle/);
    assert.doesNotMatch(filtered.content[0].text, /ignored/);
    const nested = await executeGrep(client, { pattern: "export", glob: "src/**/*.ts" }, { cwd: directory });
    assert.match(nested.content[0].text, /src\/main\.ts:1: export/);
    await assert.rejects(executeGrep(client, { pattern: "[" }, { cwd: directory }), /regex parse error/);
    assert.deepEqual(await readFile(path.join(directory, "nested", name)), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
