import asyncio

import pytest

from external_sandbox.client import Shell, b64, py


@pytest.mark.contract("S1")
@pytest.mark.contract("S2")
async def test_binary_streaming_with_incremental_input_and_eof(client, idle):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    payload = bytes(range(256)) * 256
    try:
        await shell.send(type="start", command="printf ready; cat; printf '\\000\\377err' >&2; exit 23")
        await shell.until("started")
        await shell.until("stdout")  # Proves output arrives before stdin/EOF, without timing assumptions.
        assert shell.output["stdout"] == b"ready"
        for index in range(0, len(payload), 32768):
            await shell.send(type="stdin", id=index, data=b64(payload[index:index + 32768]))
            await shell.until("stdin_ack", id=index)
        await shell.send(type="stdin_eof")
        event = await shell.finish()
        assert event["exitCode"] == 23
        assert shell.output == {"stdout": b"ready" + payload, "stderr": b"\0\xfferr"}
        assert [e["type"] for e in shell.events].count("stdin_closed") == 1
    finally:
        await ws.close()


@pytest.mark.contract("S3")
@pytest.mark.parametrize("mode", ["cancel", "timeout", "output"])
async def test_stream_termination(client, idle, mode):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    try:
        command = py("import os; os.write(1,b'x'*8192)") if mode == "output" else "printf ready; sleep 60"
        options = {"maxOutputBytes": 256} if mode == "output" else {"timeoutMs": 100} if mode == "timeout" else {}
        await shell.send(type="start", command=command, stdin=False, **options)
        await shell.until("started")
        if mode == "cancel":
            await shell.until("stdout")
            await shell.send(type="cancel")
        event = await shell.finish()
        assert event["signal"] is not None and event["exitCode"] is None
        assert event["timedOut"] is (mode == "timeout")
        assert event["outputLimitExceeded"] is (mode == "output")
    finally:
        await ws.close()


@pytest.mark.contract("S4")
@pytest.mark.parametrize("invalid", [{"type": "cancel"}, {"type": "start", "command": "true", "stdin": "yes"},
                                      {"type": "start", "command": "true", "extra": 1}, [], "not-json", b"{}"],
                         ids=["first-message", "stdin-type", "unknown-field", "array", "json", "binary-frame"])
async def test_invalid_stream_start(client, invalid):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    try:
        if isinstance(invalid, bytes):
            await ws.send_bytes(invalid)
        elif isinstance(invalid, str):
            await ws.send_str(invalid)
        else:
            await ws.send_json(invalid)
        assert (await shell.event())["type"] == "error"
        await shell.closed()
    finally:
        await ws.close()


@pytest.mark.contract("S4")
@pytest.mark.parametrize("invalid", [
    {"type": "start", "command": "true"}, {"type": "mystery"},
    {"type": "stdin", "id": -1, "data": "YQ=="}, {"type": "stdin", "id": 0, "data": "YQ"},
    {"type": "stdin", "id": 0, "data": "YR=="}, {"type": "stdin", "id": 0, "data": b64(b'x' * 32769)},
    {"type": "stdin", "id": 0, "data": "YQ==", "extra": 1}, {"type": "cancel", "extra": 1}],
    ids=["duplicate-start", "unknown-type", "id", "base64-padding", "base64-bits", "chunk-limit", "stdin-fields", "cancel-fields"])
async def test_invalid_stream_message(client, idle, invalid):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    try:
        await shell.send(type="start", command="sleep 60", stdin=True)
        await shell.until("started")
        await ws.send_json(invalid)
        await shell.until("error")
        await shell.closed()
    finally:
        await ws.close()


@pytest.mark.contract("S4")
@pytest.mark.parametrize("mode", ["duplicate-id", "disabled", "after-eof"])
async def test_stdin_lifecycle_validation(client, idle, mode):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    try:
        await shell.send(type="start", command="cat; sleep 60", stdin=mode != "disabled")
        await shell.until("started")
        if mode == "duplicate-id":
            await shell.send(type="stdin", id=1, data="YQ==")
            await shell.until("stdin_ack", id=1)
        if mode == "after-eof":
            await shell.send(type="stdin_eof")
            await shell.until("stdin_closed")
        await shell.send(type="stdin", id=1, data="YQ==")
        await shell.until("error")
        await shell.closed()
    finally:
        await ws.close()


@pytest.mark.contract("S5")
async def test_stream_disconnect_cancels(client, idle):
    ws = await client.ws("/exec/ws")
    try:
        await ws.send_json({"type": "start", "command": "sleep 60", "stdin": False})
        assert (await client.receive(ws))["type"] == "started"
    finally:
        await ws.close()
    await idle()


@pytest.mark.contract("S5")
async def test_stream_requires_start_before_deadline(client):
    ws = await client.ws("/exec/ws")
    shell = Shell(client, ws)
    try:
        async with asyncio.timeout(15):
            await shell.until("error")
            await shell.closed()
    finally:
        await ws.close()
