import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { SandboxClient } from "../transport.mjs";

const exitFrame = (extra = {}) => ({ type: "exit", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false, ...extra });
const send = (socket, frame) => socket.send(JSON.stringify(frame));
const output = (socket, stream, data) => send(socket, { type: stream, data: Buffer.from(data).toString("base64") });

async function fixture(t, onFrame, { health = { status: "ready", defaultCwd: "/workspace", mounts: [] }, status = 200 } = {}) {
  const requests = [];
  const frames = [];
  const httpServer = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    response.writeHead(status, { "Content-Type": "application/json", ...(status === 302 ? { Location: "/redirected" } : {}) });
    response.end(typeof health === "string" ? health : JSON.stringify(health));
  });
  const wsServer = new WebSocketServer({ server: httpServer, path: "/exec/ws" });
  let callbackError;
  wsServer.on("connection", (socket, request) => {
    requests.push({ url: request.url, headers: request.headers });
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      try { onFrame(socket, frame); }
      catch (error) { callbackError = error; socket.terminate(); }
    });
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  t.after(async () => {
    for (const client of wsServer.clients) client.terminate();
    await new Promise((resolve) => wsServer.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    if (callbackError) throw callbackError;
  });
  return { url: `http://127.0.0.1:${httpServer.address().port}`, requests, frames, httpServer };
}

test("health chooses guest cwd; command output and nonzero status are preserved", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type !== "start") return;
    send(socket, { type: "started", processId: "test" });
    output(socket, "stdout", Buffer.from([0, 255, 65]));
    output(socket, "stderr", "problem\n");
    send(socket, exitFrame({ exitCode: 7 }));
  });
  const result = await new SandboxClient({ url: server.url }).exec("example");
  assert.deepEqual(result, { stdout: Buffer.from([0, 255, 65]), stderr: Buffer.from("problem\n"), exitCode: 7, timedOut: false, outputLimitExceeded: false });
  assert.deepEqual(server.frames[0], { type: "start", command: "example", cwd: "/workspace", stdin: false, timeoutMs: 120000, maxOutputBytes: 16777216 });
  assert.deepEqual(server.requests.map((request) => request.url), ["/health", "/exec/ws"]);
  assert.equal(server.requests[1].headers.origin, undefined);
  assert.equal(server.requests[1].headers.authorization, undefined);
  assert.equal(server.frames[0].env, undefined);
});

test("explicit cwd and timeout override health defaults without local path resolution", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type !== "start") return;
    send(socket, { type: "started" });
    send(socket, exitFrame({ exitCode: null, signal: 15 }));
  });
  const result = await new SandboxClient({ url: server.url, cwd: "/constructor" }).exec("test", { cwd: "/guest/only", timeoutMs: 500 });
  assert.equal(result.exitCode, 143);
  assert.equal(server.frames[0].cwd, "/guest/only");
  assert.equal(server.frames[0].timeoutMs, 500);
  assert.deepEqual(server.requests.map((request) => request.url), ["/exec/ws"]);
});

test("stdin is chunked with one acknowledgement in flight and an explicit EOF", async (t) => {
  const stdin = Buffer.alloc(90_000);
  for (let index = 0; index < stdin.length; index++) stdin[index] = index % 256;
  const chunks = [];
  let awaitingAck = false;
  const server = await fixture(t, (socket, frame) => {
    if (frame.type === "start") send(socket, { type: "started" });
    if (frame.type === "stdin") {
      assert.equal(awaitingAck, false, "client waited for previous acknowledgement");
      assert.equal(frame.id, chunks.length);
      chunks.push(Buffer.from(frame.data, "base64"));
      awaitingAck = true;
      output(socket, "stdout", "interleaved");
      setTimeout(() => { awaitingAck = false; send(socket, { type: "stdin_ack", id: frame.id }); }, 5);
    }
    if (frame.type === "stdin_eof") {
      assert.equal(awaitingAck, false);
      send(socket, { type: "stdin_closed" });
      send(socket, exitFrame());
    }
  });
  const result = await new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("cat", { stdin });
  assert.deepEqual(chunks.map((chunk) => chunk.length), [32768, 32768, 24464]);
  assert.deepEqual(Buffer.concat(chunks), stdin);
  assert.equal(result.stdout.toString(), "interleavedinterleavedinterleaved");
  assert.deepEqual(server.frames.map((frame) => frame.type), ["start", "stdin", "stdin", "stdin", "stdin_eof"]);
});

test("empty string stdin sends EOF; missing stdin disables input", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type === "start") {
      assert.equal(frame.stdin, true);
      send(socket, { type: "started" });
    }
    if (frame.type === "stdin_eof") {
      send(socket, { type: "stdin_closed" });
      send(socket, exitFrame());
    }
  });
  await new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("cat", { stdin: "" });
  assert.deepEqual(server.frames.map((frame) => frame.type), ["start", "stdin_eof"]);
});

test("early stdin closure stops sending without failing a successful command", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type === "start") send(socket, { type: "started" });
    if (frame.type === "stdin") {
      send(socket, { type: "stdin_closed" });
      output(socket, "stdout", "done");
      send(socket, exitFrame());
    }
  });
  const result = await new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("head", { stdin: Buffer.alloc(100_000) });
  assert.equal(result.stdout.toString(), "done");
  assert.deepEqual(server.frames.map((frame) => frame.type), ["start", "stdin"]);
});

test("streaming preserves order and does not retain another output copy", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type !== "start") return;
    send(socket, { type: "started" });
    output(socket, "stdout", "one");
    output(socket, "stderr", "two");
    output(socket, "stdout", "three");
    send(socket, exitFrame());
  });
  const chunks = [];
  const result = await new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test", { onData: (data, stream) => chunks.push([stream, data.toString()]) });
  assert.deepEqual(chunks, [["stdout", "one"], ["stderr", "two"], ["stdout", "three"]]);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.stderr.length, 0);
});

test("aborting running execution sends cancel and rejects with AbortError", async (t) => {
  const abort = new AbortController();
  let gotCancel;
  const canceled = new Promise((resolve) => { gotCancel = resolve; });
  const server = await fixture(t, (socket, frame) => {
    if (frame.type === "start") { send(socket, { type: "started" }); abort.abort(); }
    if (frame.type === "cancel") gotCancel();
  });
  await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("sleep 60", { signal: abort.signal }), { name: "AbortError" });
  await canceled;
  assert.deepEqual(server.frames.map((frame) => frame.type), ["start", "cancel"]);
});

test("pre-aborted execution never connects", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(new SandboxClient({ url: "http://127.0.0.1:1" }).exec("test", { signal: abort.signal }), { name: "AbortError" });
});

test("disconnects are failures, including normal WebSocket close without an exit", async (t) => {
  for (const terminate of [false, true]) {
    await t.test(terminate ? "abrupt disconnect" : "normal close", async (t) => {
      const server = await fixture(t, (socket, frame) => {
        if (frame.type !== "start") return;
        send(socket, { type: "started" });
        if (terminate) socket.terminate(); else socket.close(1000);
      });
      await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test"), /disconnected without an exit result/);
    });
  }
});

test("server error, timeout, and output-limit results reject explicitly", async (t) => {
  const cases = [
    [{ type: "error", error: "container stopped" }, /API error: container stopped/],
    [exitFrame({ timedOut: true }), /timed out/],
    [exitFrame({ outputLimitExceeded: true }), /output limit/],
    [exitFrame({ exitCode: null }), /neither an exit code nor a signal/],
    [exitFrame({ exitCode: "0" }), /invalid execution result/],
  ];
  for (const [frame, expected] of cases) {
    await t.test(expected.source, async (t) => {
      const server = await fixture(t, (socket, request) => {
        if (request.type !== "start") return;
        send(socket, { type: "started" });
        send(socket, frame);
      });
      await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test"), expected);
    });
  }
});

test("malformed and out-of-order protocol frames fail closed", async (t) => {
  const cases = [
    [(socket) => socket.send("not json"), /invalid JSON/],
    [(socket) => socket.send(Buffer.from("binary")), /binary WebSocket/],
    [(socket) => send(socket, []), /invalid WebSocket message/],
    [(socket) => send(socket, { type: "unknown" }), /unknown message type/],
    [(socket) => send(socket, { type: "started" }), /duplicate started/],
    [(socket) => send(socket, { type: "stdout", data: "@@@@" }), /invalid base64/],
    [(socket) => send(socket, { type: "stdout", data: "AB==" }), /invalid base64/],
    [(socket) => send(socket, { type: "stdin_ack", id: 0 }), /unexpected stdin acknowledgement/],
    [(socket) => send(socket, { type: "stdin_closed" }), /unexpected stdin_closed/],
  ];
  for (const [sendBadFrame, expected] of cases) {
    await t.test(expected.source, async (t) => {
      const server = await fixture(t, (socket, frame) => {
        if (frame.type !== "start") return;
        send(socket, { type: "started" });
        sendBadFrame(socket);
      });
      await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test"), expected);
    });
  }
  await t.test("output before started", async (t) => {
    const server = await fixture(t, (socket, frame) => {
      if (frame.type === "start") output(socket, "stdout", "oops");
    });
    await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test"), /before started/);
  });
});

test("client also enforces combined output limit when server ignores requested cap", async (t) => {
  const server = await fixture(t, (socket, frame) => {
    if (frame.type !== "start") return;
    assert.equal(frame.maxOutputBytes, 5);
    send(socket, { type: "started" });
    output(socket, "stdout", "abc");
    output(socket, "stderr", "def");
    send(socket, exitFrame());
  });
  await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace", maxOutputBytes: 5 }).exec("test"), /output limit/);
});

test("callback failure cancels the remote command", async (t) => {
  let gotCancel;
  const canceled = new Promise((resolve) => { gotCancel = resolve; });
  const server = await fixture(t, (socket, frame) => {
    if (frame.type === "start") { send(socket, { type: "started" }); output(socket, "stdout", "test"); }
    if (frame.type === "cancel") gotCancel();
  });
  await assert.rejects(new SandboxClient({ url: server.url, cwd: "/workspace" }).exec("test", { onData: () => { throw new Error("consumer failed"); } }), /consumer failed/);
  await canceled;
});

test("health rejects redirects, invalid JSON, unready servers, and invalid guest directories", async (t) => {
  const cases = [
    [{ status: 302 }, /HTTP 302/],
    [{ health: "not json" }, /invalid JSON/],
    [{ health: { status: "starting", defaultCwd: "/workspace" } }, /not ready/],
    [{ health: { status: "ready", defaultCwd: "relative" } }, /absolute guest path/],
  ];
  for (const [options, expected] of cases) {
    await t.test(expected.source, async (t) => {
      const server = await fixture(t, () => {}, options);
      await assert.rejects(new SandboxClient({ url: server.url }).exec("test"), expected);
      assert.equal(server.requests.length, 1);
      assert.equal(server.frames.length, 0);
    });
  }
});

test("network failure rejects without attempting another execution route", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(new SandboxClient({ url, cwd: "/workspace" }).exec("test"), /Sandbox connection failed/);
});

test("an oversized health response is rejected before execution", async (t) => {
  const server = await fixture(t, () => {}, { health: { status: "ready", defaultCwd: "/workspace", extra: "x".repeat(300_000) } });
  await assert.rejects(new SandboxClient({ url: server.url }).exec("test"), /exceeds 256 KiB/);
  assert.equal(server.frames.length, 0);
});

test("aborting a pending health request stops execution setup", async (t) => {
  const server = await fixture(t, () => {});
  const abort = new AbortController();
  server.httpServer.removeAllListeners("request");
  server.httpServer.on("request", () => abort.abort());
  await assert.rejects(new SandboxClient({ url: server.url }).exec("test", { signal: abort.signal }), { name: "AbortError" });
  assert.equal(server.frames.length, 0);
});

test("invalid configuration and arguments fail before connecting", async () => {
  for (const url of ["file:///tmp", "http://localhost/path", "http://user:secret@localhost", "http://localhost/?token=secret"]) {
    assert.throws(() => new SandboxClient({ url }), /Sandbox URL/);
  }
  for (const timeoutMs of [0, null, 300001, 2.5]) assert.throws(() => new SandboxClient({ url: "http://localhost", timeoutMs }), /timeoutMs/);
  assert.throws(() => new SandboxClient({ url: "http://localhost", maxOutputBytes: 16777217 }), /maxOutputBytes/);
  assert.throws(() => new SandboxClient({ url: "http://localhost", cwd: "relative" }), /absolute guest path/);
  const client = new SandboxClient({ url: "http://127.0.0.1:1", cwd: "/workspace" });
  await assert.rejects(client.exec(""), /nonempty string/);
  await assert.rejects(client.exec("echo\0test"), /nonempty string/);
  await assert.rejects(client.exec("test", { timeoutMs: null }), /timeoutMs/);
  await assert.rejects(client.exec("test", { stdin: 42 }), /Buffer or string/);
  await assert.rejects(client.exec("test", { cwd: "relative" }), /absolute guest path/);
});
