import asyncio

import pytest

from exec_server_spec.client import py


@pytest.mark.contract("T1")
async def test_discovery(client, request):
    health = await client.request("GET", "/health")
    mounts = await client.request("GET", "/mounts")
    assert health.status == mounts.status == 200
    data = health.json()
    assert data["status"] == "ready"
    assert type(data["activeCommands"]) is int and data["activeCommands"] >= 0
    for name in ("backend", "architecture", "shell", "defaultCwd"):
        assert isinstance(data[name], str) and data[name]
    assert data["defaultCwd"].startswith("/")
    assert data["mounts"] == mounts.json()["mounts"]
    for mount in data["mounts"]:
        assert mount["mode"] in {"ro", "rw"}
        assert all(isinstance(mount[k], str) and mount[k] for k in ("name", "hostPath", "guestPath"))
        assert mount["hostPath"].startswith("/") and mount["guestPath"].startswith("/")
    request.config.spec_report["server"] = data
    for reply in (health, mounts):
        assert reply.headers["Cache-Control"] == "no-store"
        assert reply.headers["X-Content-Type-Options"] == "nosniff"


@pytest.mark.contract("H1")
async def test_buffered_streams_exit_stdin_env_and_cwd(client, space):
    result = await client.execute('printf "%s\\n" "$SPEC_VALUE"; pwd; cat; printf problem >&2; exit 7',
                                  cwd=space, env={"SPEC_VALUE": "spaces;$(not evaluated)"}, stdin="héllo\0\n")
    assert result["stdout"] == f"spaces;$(not evaluated)\n{space}\nhéllo\0\n"
    assert result["stderr"] == "problem" and result["exitCode"] == 7
    assert not result["timedOut"] and not result["outputLimitExceeded"]


@pytest.mark.contract("H1")
async def test_buffered_empty_stdin_is_eof_and_invalid_utf8_is_replaced(client):
    result = await client.success("cat; printf '\\377'")
    assert result["stdout"] == "\ufffd"


@pytest.mark.contract("H1")
async def test_shell_state_is_fresh_but_files_persist(client, space):
    await client.success("export SPEC_TRANSIENT=secret; printf persistent > saved", cwd=space)
    result = await client.success('printf "%s" "${SPEC_TRANSIENT-unset}"; cat saved', cwd=space)
    assert result["stdout"] == "unsetpersistent"


@pytest.mark.contract("H2")
@pytest.mark.parametrize("body", [None, [], {}, {"command": " "}, {"command": 1},
    {"command": "x\0y"}, {"command": "x" * 65537}, {"command": "true", "extra": 1},
    {"command": "true", "cwd": "relative"}, {"command": "true", "cwd": "/" + "x" * 4096},
    {"command": "true", "env": []}, {"command": "true", "env": {"bad-name": "a"}},
    {"command": "true", "env": {"A": 1}}, {"command": "true", "env": {"A": "x\0"}},
    {"command": "true", "env": {f"A{i}": "" for i in range(129)}},
    {"command": "true", "env": {"A": "x" * 32768}},
    {"command": "true", "stdin": "x" * 32769}, {"command": "true", "stdin": False},
    {"command": "true", "timeoutMs": 0}, {"command": "true", "timeoutMs": 300001},
    {"command": "true", "timeoutMs": True}, {"command": "true", "timeoutMs": 1.5},
    {"command": "true", "maxOutputBytes": 0}, {"command": "true", "maxOutputBytes": 16777217}],
    ids=["null", "array", "missing-command", "blank", "number", "nul", "command-limit", "unknown-field",
         "relative-cwd", "cwd-limit", "env-array", "env-name", "env-type", "env-nul", "env-count", "env-limit",
         "stdin-limit", "stdin-type", "timeout-zero", "timeout-limit", "timeout-bool", "timeout-fraction",
         "output-zero", "output-limit"])
async def test_invalid_exec_request(client, body):
    # Send explicit JSON null rather than aiohttp's json=None (which omits the body).
    import json
    response = await client.request("POST", "/exec", data=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status == 400, (response.status, response.text)
    assert isinstance(response.json()["error"], str)


@pytest.mark.contract("H2")
@pytest.mark.parametrize("data,headers,status", [
    (b'{', {"Content-Type": "application/json"}, 400),
    (b'{"command":"\xff"}', {"Content-Type": "application/json"}, 400),
    (b'{"command":"true","timeoutMs":NaN}', {"Content-Type": "application/json"}, 400),
    (b'{}', {"Content-Type": "text/plain"}, 415),
    (b'{}', {"Content-Type": "application/json", "Content-Encoding": "gzip"}, 415),
    (b' ' * 262145, {"Content-Type": "application/json"}, 413)],
    ids=["json", "utf8", "nan", "content-type", "compression", "body-limit"])
async def test_invalid_http_encoding(client, data, headers, status):
    response = await client.request("POST", "/exec", data=data, headers=headers)
    assert response.status == status, (response.status, response.text)
    assert isinstance(response.json()["error"], str)


@pytest.mark.contract("H2")
async def test_http_routes_and_execution_error(client):
    response = await client.request("GET", "/exec")
    assert response.status == 405 and "POST" in response.headers["Allow"]
    assert (await client.request("GET", "/not-a-route")).status == 404
    response = await client.request("POST", "/exec", json={"command": "true", "cwd": "/not-a-spec-directory"})
    assert response.status == 500 and isinstance(response.json()["error"], str)
    assert (await client.success("printf alive"))["stdout"] == "alive"


@pytest.mark.contract("H3")
@pytest.mark.parametrize("field,command,options", [
    ("timedOut", "sleep 60", {"timeoutMs": 100}),
    ("outputLimitExceeded", py("import os; os.write(1,b'x'*8192)"), {"maxOutputBytes": 256})])
async def test_exec_limits(client, idle, field, command, options):
    result = await client.execute(command, **options)
    assert result[field] is True, result
    assert result["exitCode"] is None and result["signal"] is not None, result


@pytest.mark.contract("H4")
async def test_concurrent_requests_are_independent(client, idle):
    results = await asyncio.gather(*(client.success(f"sleep 0.1; printf '{i}'") for i in range(3)))
    assert [r["stdout"] for r in results] == ["0", "1", "2"]


@pytest.mark.contract("H4")
async def test_http_disconnect_cancels_process(client, idle):
    task = asyncio.create_task(client.request("POST", "/exec", json={"command": "sleep 60"}))
    try:
        async with asyncio.timeout(client.deadline):
            while (await client.request("GET", "/health")).json()["activeCommands"] == 0:
                await asyncio.sleep(0.05)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    await idle()
