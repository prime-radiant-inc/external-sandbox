import asyncio

import pytest

from exec_server_spec.client import assert_fields, RPC, RPCError, b64, unb64, uri


@pytest.mark.contract("C1")
async def test_handshake_and_error_recovery(client):
    ws = await client.ws("/codex")
    rpc = RPC(client, ws)
    try:
        with pytest.raises(RPCError) as error:
            await rpc.call("environment/info")
        assert error.value.detail["code"] == -32002
        result = await rpc.initialize()
        info = await rpc.call("environment/info")
        assert info == result["environmentInfo"]
        assert info["platformOs"] == "linux" and info["shell"]["path"] == "/bin/bash"
        for field in ("cwd", "userHomeDir", "tempDir"):
            assert info[field].startswith("file:///")
        assert isinstance(info["temporaryDirectories"], list) and isinstance(info["capabilities"], dict)
        with pytest.raises(RPCError) as error:
            await rpc.call("initialize", {"clientName": "again"})
        assert error.value.detail["code"] == -32602
        with pytest.raises(RPCError) as error:
            await rpc.call("method/not-supported")
        assert error.value.detail["code"] == -32601
        assert_fields(await rpc.call("environment/status"), {"status": "ready"})
    finally:
        await ws.close()


@pytest.mark.contract("C1")
async def test_session_resume_rejected(client):
    ws = await client.ws("/codex")
    try:
        with pytest.raises(RPCError) as error:
            await RPC(client, ws).call("initialize", {"clientName": "spec", "resumeSessionId": "old"})
        assert error.value.detail["code"] == -32602
    finally:
        await ws.close()


@pytest.mark.contract("C2")
async def test_literal_argv_binary_output_and_replay(rpc, space):
    payload = "spaces;$(uname) ' quote"
    script = "import os,sys; os.write(1,sys.argv[1].encode()+b'\\x00\\xff'); os.write(2,b'err\\x00'); sys.exit(7)"
    await rpc.start("literal", [rpc.python, "-c", script, payload], cwd=uri(space))
    output, code, events = await rpc.complete("literal")
    assert code == 7 and output == {"stdout": payload.encode() + b"\0\xff", "stderr": b"err\0"}
    replay = await rpc.call("process/read", {"processId": "literal", "afterSeq": 0})
    assert replay["closed"] is True and replay["exited"] is True and replay["exitCode"] == 7
    assert replay["failure"] is None and replay["sandboxDenied"] is False
    assert len(replay["chunks"]) == len(events) - 2
    for chunk, event in zip(replay["chunks"], events[:-2], strict=True):
        assert_fields(chunk, {k: event["params"][k] for k in ("seq", "stream", "chunk")})
    assert replay["nextSeq"] == events[-1]["params"]["seq"] + 1
    empty = await rpc.call("process/read", {"processId": "literal", "afterSeq": replay["nextSeq"] - 1})
    assert empty["chunks"] == []


@pytest.mark.contract("C2")
async def test_env_policy_and_arg0(rpc):
    policy = {"inherit": "none", "exclude": [], "includeOnly": ["SPEC_*"],
              "set": {"SPEC_SET": "policy", "DROP": "no", "SPEC_OVERRIDE": "old"}}
    await rpc.start("env", ["/bin/bash", "-c", 'printf "%s|%s|%s|%s|%s" "$0" "$SPEC_SET" "$SPEC_OVERRIDE" "${DROP-unset}" "${NODE_REPL_AUTH_TOKEN-unset}"'],
                    envPolicy=policy, env={"SPEC_OVERRIDE": "request", "NODE_REPL_AUTH_TOKEN": "must-strip"}, arg0="custom-argv0")
    output, code, _ = await rpc.complete("env")
    assert code == 0 and output["stdout"] == b"custom-argv0|policy|request|unset|unset"


@pytest.mark.contract("C3")
async def test_write_deduplication_and_statuses(rpc):
    script = "import os; data=os.read(0,1); os.write(1,data); data=os.read(0,1); os.write(1,data)"
    await rpc.start("input", [rpc.python, "-c", script], pipeStdin=True)
    params = {"processId": "input", "writeId": "one", "chunk": b64(b"a")}
    assert_fields(await rpc.call("process/write", params), {"status": "accepted"})
    assert_fields(await rpc.call("process/write", params), {"status": "accepted"})
    with pytest.raises(RPCError) as error:
        await rpc.call("process/write", {**params, "chunk": b64(b"z")})
    assert error.value.detail["code"] == -32602
    assert_fields(await rpc.call("process/write", {**params, "writeId": "two", "chunk": b64(b"b")}), {"status": "accepted"})
    output, code, _ = await rpc.complete("input")
    assert code == 0 and output["stdout"] == b"ab"
    assert_fields(await rpc.call("process/write", params), {"status": "stdinClosed"})
    assert_fields(await rpc.call("process/write", {"processId": "missing"}), {"status": "unknownProcess"})
    with pytest.raises(RPCError):
        await rpc.call("process/read", {"processId": "missing"})


@pytest.mark.contract("C4")
@pytest.mark.parametrize("method,params,code", [("process/signal", {"signal": "interrupt"}, 130),
                                              ("process/terminate", {}, 137)])
async def test_signal_and_terminate(rpc, idle, method, params, code):
    await rpc.start("long", ["/bin/bash", "-c", "printf ready; exec sleep 60"])
    # Wait for actual program output before signaling; process spawn alone isn't readiness.
    async with asyncio.timeout(rpc.client.deadline):
        while not any(n.get("method") == "process/output" for n in rpc.notifications):
            rpc.notifications.append(await rpc.client.receive(rpc.ws))
    response = await rpc.call(method, {"processId": "long", **params})
    assert_fields(response, {"running": True} if method == "process/terminate" else {})
    _, exit_code, _ = await rpc.complete("long")
    assert exit_code == code
    assert_fields(await rpc.call("process/terminate", {"processId": "long"}), {"running": False})
    assert_fields(await rpc.call("process/signal", {"processId": "missing", "signal": "interrupt"}), {})


@pytest.mark.contract("C4")
async def test_codex_disconnect_cancels(client, idle):
    ws = await client.ws("/codex")
    rpc = RPC(client, ws)
    try:
        await rpc.initialize()
        await rpc.start("disconnect", ["/bin/sleep", "60"])
    finally:
        await ws.close()
    await idle()


@pytest.mark.contract("C5")
@pytest.mark.parametrize("override", [{"tty": True}, {"tty": None}, {"shellSnapshot": "x"},
    {"sandbox": {"permissions": {"type": "managed"}}}, {"enforceManagedNetwork": True},
    {"argv": []}, {"argv": [""]}, {"argv": ["true\0"]}, {"env": {"BAD-KEY": "x"}},
    {"pipeStdin": "yes"}, {"cwd": "/workspace"}, {"envPolicy": {"inherit": "unknown"}}],
    ids=["pty", "tty-null", "snapshot", "sandbox", "network", "empty-argv", "empty-executable", "nul",
         "env", "stdin", "cwd-uri", "env-policy"])
async def test_invalid_process_start(rpc, override):
    with pytest.raises(RPCError):
        await rpc.call("process/start", {"processId": "invalid", "argv": ["/bin/true"], "cwd": rpc.info["cwd"], "env": {}, "tty": False, **override})
    assert_fields(await rpc.call("environment/status"), {"status": "ready"})


@pytest.mark.contract("C5")
async def test_process_ids_and_invalid_write(rpc):
    await rpc.start("unique", ["/bin/sleep", "60"], pipeStdin=True)
    try:
        with pytest.raises(RPCError):
            await rpc.start("unique", ["/bin/true"])
        for chunk in ("YQ", "YR==", b64(b"x" * 32769)):
            with pytest.raises(RPCError):
                await rpc.call("process/write", {"processId": "unique", "writeId": "bad", "chunk": chunk})
        with pytest.raises(RPCError):
            await rpc.call("process/signal", {"processId": "unique", "signal": "kill"})
    finally:
        await rpc.call("process/terminate", {"processId": "unique"})
        await rpc.complete("unique")


@pytest.mark.contract("L1")
async def test_replay_reports_eviction(rpc):
    # Two MiB is above the replay window but comfortably below the output cap.
    await rpc.start("evict", [rpc.python, "-c", "import os; os.write(1,b'x'*(2*1024*1024))"])
    output, code, _ = await rpc.complete("evict")
    assert code == 0 and len(output["stdout"]) == 2 * 1024 * 1024
    replay = await rpc.call("process/read", {"processId": "evict", "afterSeq": 0, "maxBytes": 32768})
    assert isinstance(replay["failure"], str) and replay["failure"]
    assert replay["chunks"] and all(unb64(c["chunk"]) for c in replay["chunks"])


@pytest.mark.contract("C2")
async def test_multiple_processes_share_one_session_without_mixing_output(rpc):
    await rpc.start("first", ["/bin/bash", "-c", "sleep 0.1; printf first"])
    await rpc.start("second", ["/bin/bash", "-c", "printf second"])
    second, code2, _ = await rpc.complete("second")
    first, code1, _ = await rpc.complete("first")
    assert code1 == code2 == 0
    assert first["stdout"] == b"first" and second["stdout"] == b"second"


@pytest.mark.contract("C1")
async def test_initialized_notification_is_required(client):
    ws = await client.ws("/codex")
    rpc = RPC(client, ws)
    try:
        await rpc.call("initialize", {"clientName": "spec"})
        with pytest.raises(RPCError) as error:
            await rpc.call("environment/status")
        assert error.value.detail["code"] == -32002
        await rpc.notify("initialized")
        assert_fields(await rpc.call("environment/status"), {"status": "ready"})
    finally:
        await ws.close()
