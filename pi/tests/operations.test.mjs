import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const uvEnv = { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR || path.join(tmpdir(), "sandbox-exec-uv-cache") };

// The helper supports guest Python 3.12 and newer. Version-specific checks use
// an installed interpreter only; tests never download Python.
function installedPython(version) {
  return spawnSync("uv", ["python", "find", "--no-project", version], { env: uvEnv }).status === 0;
}

function helperClient(python) {
  const version = python ? ["--python", python] : [];
  return { async exec(_command, options) {
    return new Promise((resolve, reject) => {
      const child = spawn("uv", ["run", "--no-project", "--offline", ...version, "python", "-c", GUEST_HELPER], {
        cwd: options.cwd,
        env: uvEnv,
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

for (const python of [undefined, "3.12"]) {
  const label = python ? ` with Python ${python}` : "";
  const skip = python && !installedPython(python) && `Install Python ${python} with uv to run this check`;
  test(`guest helper handles binary filenames, stats, images, ignored search and context${label}`, { skip }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-remote-operations-"));
    try {
      const client = helperClient(python);
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
}

// The helper's glob matching must agree with PurePosixPath.full_match, which is
// available as a reference on Python 3.13 and newer.
test("guest helper glob matching agrees with PurePosixPath.full_match", { skip: !installedPython(">=3.13") && "Install Python 3.13 or newer with uv" }, async () => {
  const script = String.raw`
import itertools, json, pathlib, sys
helper = {"__name__": "guest_helper"}
exec(sys.stdin.read(), helper)
paths = ["a", "a/b", "a/b/c", "a/b/c/d.py", "src/main.ts", "src/lib/util.ts", "src/lib/deep/x.ts",
         ".hidden/x.ts", "src/.cfg", "x.py", "docs/README.md", "a.b/c", "[x]/y", "b", "a/a/a", "dir with space/f.txt"]
patterns = ["a", "a/*", "a/**", "**", "**/*.ts", "src/**/*.ts", "src/*.ts", "**/b/**", "a/**/c", "a/**/**/c",
            "*/*", "?/b", "a/b/c/d.py", "**/.hidden/**", "src/.*", "**/*", "a/*/c", "[ab]/b", "[!x]/b/**",
            "src/**", "**/c", "a/b/", "./a/b", "a//b", "**/**", "a/**/b/**/c", "**/a/**", "*/**/*.py",
            "src/lib/**", "a/*/*/*", "[[]x]/y", "dir with space/*", "**/*.TS", "a/b/**/"]
differences = [[p, q] for p, q in itertools.product(paths, patterns)
               if helper["full_match"](p, q) != pathlib.PurePosixPath(p).full_match(q)]
print(json.dumps({"pairs": len(paths) * len(patterns), "differences": differences}))
`;
  const result = spawnSync("uv", ["run", "--no-project", "--offline", "--python", ">=3.13", "python", "-c", script],
    { input: GUEST_HELPER, env: uvEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { pairs, differences } = JSON.parse(result.stdout);
  assert.equal(pairs, 544);
  assert.deepEqual(differences, []);
});
