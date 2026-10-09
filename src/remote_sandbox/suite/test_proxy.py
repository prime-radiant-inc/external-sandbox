"""Requires a dedicated proxy-enabled server on the same host as this runner."""
import asyncio
import gzip
import copy
import json
import uuid

from aiohttp import web
import pytest
import pytest_asyncio

from remote_sandbox.client import py, token

pytestmark = [pytest.mark.proxy]


@pytest_asyncio.fixture
async def management(client):
    page = await client.request("GET", "/proxy")
    assert page.status == 200, "Proxy profile requires a proxy-enabled server"
    headers = {"X-Proxy-Token": token(page.text, "proxy-token")}
    response = await client.request("GET", "/proxy/api", headers=headers)
    assert response.status == 200, response.text
    snapshot = response.json()
    assert snapshot["enabled"] is True
    original = snapshot["policy"]
    try:
        yield headers, original
    finally:
        restored = await client.request("PUT", "/proxy/api", headers=headers, json=original)
        assert restored.status == 200, "Failed to restore proxy policy: " + restored.text


@pytest.mark.contract("P1")
async def test_proxy_access_and_atomic_policy_validation(client, management):
    headers, original = management
    assert (await client.request("GET", "/proxy/api")).status == 403
    assert (await client.request("GET", "/proxy/api", headers={"X-Proxy-Token": "wrong"})).status == 403
    assert (await client.request("GET", "/proxy/api", headers={**headers, "Origin": "http://evil.invalid"})).status == 403
    assert (await client.request("GET", "/proxy/api", headers={**headers, "Origin": client.url})).status == 200
    invalid = [{"allow": "not-an-array"}, {"allow": [], "unknown": 1},
        {"allow": [{"origin": "https://*.example.com"}]}, {"allow": [{"origin": "https://example.com/path"}]},
        {"allow": [{"origin": "https://example.com", "unknown": 1}]},
        {"allow": [{"origin": "http://example.com", "credential": {
            "header": "Authorization", "placeholder": "dummy", "secretEnv": "SPEC_MISSING_SECRET"}}]}]
    changed_env = copy.deepcopy(original)
    changed_env.setdefault("guestEnv", {})["SPEC_CHANGE_" + uuid.uuid4().hex] = "restart-required"
    invalid.append(changed_env)
    for policy in invalid:
        response = await client.request("PUT", "/proxy/api", headers=headers, json=policy)
        assert response.status == 400, (policy, response.status, response.text)
        after = await client.request("GET", "/proxy/api", headers=headers)
        assert after.json()["policy"] == original
    for body, extra, status in [("{", {"Content-Type": "application/json"}, 400),
                                 ("{}", {"Content-Type": "text/plain"}, 415),
                                 (gzip.compress(b'{}'), {"Content-Type": "application/json", "Content-Encoding": "gzip"}, 415),
                                 (" " * 262145, {"Content-Type": "application/json"}, 413)]:
        response = await client.request("PUT", "/proxy/api", headers={**headers, **extra}, data=body)
        assert response.status == status
    policy = {**original, "allow": []}
    updated = await client.request("PUT", "/proxy/api", headers=headers, json=policy)
    assert updated.status == 200 and updated.json()["policy"]["allow"] == []


@pytest.mark.contract("P2")
@pytest.mark.contract("P3")
async def test_proxy_http_rules_activity_and_live_revocation(client, management):
    headers, original = management
    received = []
    nonce = uuid.uuid4().hex

    async def echo(request):
        received.append((request.method, request.path))
        return web.Response(text="spec-upstream-" + nonce)

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", echo)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    rule = {"origin": origin, "methods": ["GET"], "paths": ["/allowed"], "allowCidrs": ["127.0.0.1/32"]}

    async def policy(rules):
        response = await client.request("PUT", "/proxy/api", headers=headers, json={**original, "allow": rules})
        assert response.status == 200, response.text

    async def guest(path, method="GET", direct=False):
        # Explicit ProxyHandler defeats urllib's automatic localhost bypass while still using guest proxy settings.
        code = f'''import os,urllib.request,urllib.error
url={origin + path!r}
proxy=os.environ.get('http_proxy') or os.environ.get('HTTP_PROXY')
assert proxy, 'No guest HTTP proxy configured'
os.environ['no_proxy']=''; os.environ['NO_PROXY']=''
handler=urllib.request.ProxyHandler(dict() if {direct!r} else dict(http=proxy))
request=urllib.request.Request(url,method={method!r})
try:
    with urllib.request.build_opener(handler).open(request,timeout=3) as response:
        print(str(response.status)+' '+response.read().decode())
except (urllib.error.URLError,OSError) as error:
    print('DENIED')
'''
        return await client.success(py(code), timeoutMs=10000)

    try:
        await policy([rule])
        response = await guest("/allowed?omit=" + nonce)
        assert response["stdout"].strip() == "200 spec-upstream-" + nonce, response
        assert received == [("GET", "/allowed")]
        assert (await guest("/blocked"))["stdout"].strip() == "DENIED"
        assert (await guest("/allowed", method="POST"))["stdout"].strip() == "DENIED"
        assert (await guest("/allowed", direct=True))["stdout"].strip() == "DENIED"
        await policy([{k: v for k, v in rule.items() if k != "allowCidrs"}])
        assert (await guest("/allowed"))["stdout"].strip() == "DENIED", "Private address allowed without CIDR opt-in"
        await policy([])
        assert (await guest("/allowed"))["stdout"].strip() == "DENIED"
        assert received == [("GET", "/allowed")], received
        async with asyncio.timeout(client.deadline):
            while True:
                snapshot = (await client.request("GET", "/proxy/api", headers=headers)).json()
                events = [e for e in snapshot["events"] if e["origin"] == origin]
                if any(e["decision"] == "allowed" for e in events) and any(e["decision"] == "denied" for e in events):
                    break
                await asyncio.sleep(0.05)
        assert len(snapshot["events"]) <= 500
        assert nonce not in json.dumps(snapshot["events"]), "Activity leaked query or response body"
        for event in events:
            assert event["decision"] in {"allowed", "denied", "error"}
            assert isinstance(event["timestamp"], str) and isinstance(event["reason"], str)
            assert type(event["status"]) is int and event["durationMs"] >= 0
            assert type(event["credentialInjected"]) is bool
            assert "?" not in event["path"] and "#" not in event["path"]
            assert not ({"headers", "body", "requestBody", "responseBody"} & event.keys())
    finally:
        await runner.cleanup()


@pytest.mark.contract("P2")
async def test_live_policy_update_revokes_existing_stream(client, management):
    from remote_sandbox.client import Shell
    headers, original = management
    disconnected = asyncio.Event()

    async def streaming(request):
        response = web.StreamResponse()
        await response.prepare(request)
        await response.write(b"ready\n")
        try:
            async with asyncio.timeout(client.deadline):
                while request.transport and not request.transport.is_closing():
                    await asyncio.sleep(0.05)
            disconnected.set()
        finally:
            disconnected.set()
        return response

    app = web.Application()
    app.router.add_get("/stream", streaming)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    origin = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    ws = None
    try:
        response = await client.request("PUT", "/proxy/api", headers=headers, json={**original, "allow": [
            {"origin": origin, "allowCidrs": ["127.0.0.1/32"]}]})
        assert response.status == 200, response.text
        script = f'''import os,urllib.request
os.environ['no_proxy']=''; os.environ['NO_PROXY']=''
handler=urllib.request.ProxyHandler({{'http':os.environ['http_proxy']}})
with urllib.request.build_opener(handler).open({origin + '/stream'!r}, timeout=15) as response:
    print(response.readline().decode().strip(), flush=True)
    try:
        response.read()
    except Exception:
        pass
    print('closed', flush=True)
'''
        ws = await client.ws("/exec/ws")
        shell = Shell(client, ws)
        await shell.send(type="start", command=py(script), stdin=False, timeoutMs=20000)
        await shell.until("stdout")
        assert shell.output["stdout"] == b"ready\n"
        response = await client.request("PUT", "/proxy/api", headers=headers, json={**original, "allow": []})
        assert response.status == 200
        # Must be revocation, not the guest's 15-second socket timeout.
        async with asyncio.timeout(5):
            event = await shell.finish()
            assert event["exitCode"] == 0 and shell.output["stdout"] == b"ready\nclosed\n", shell.events
            await disconnected.wait()
    finally:
        if ws is not None:
            await ws.close()
        await runner.cleanup()


@pytest.mark.proxy_tls
@pytest.mark.contract("P4")
async def test_https_credentials_redaction_and_redirect_scope(client, management, request):
    import ssl
    from remote_sandbox.tls_fixture import PLACEHOLDER, SYNTHETIC_SECRET
    headers, original = management
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(request.config.getoption("--proxy-tls-cert"), request.config.getoption("--proxy-tls-key"))
    received = []

    async def upstream(request):
        received.append((request.path, request.headers.get("Authorization")))
        if request.path == "/redirect":
            return web.Response(status=302, headers={"Location": "/not-allowed"})
        return web.Response(text=request.headers.get("Authorization", "") + "\ncredential-roundtrip")

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", upstream)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=tls)
    await site.start()
    origin = f"https://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    rule = {"origin": origin, "methods": ["GET"], "paths": ["/echo", "/redirect"], "allowCidrs": ["127.0.0.1/32"],
            "credential": {"header": "Authorization", "placeholder": PLACEHOLDER,
                           "secretEnv": "REMOTE_SANDBOX_SPEC_SECRET", "prefix": "Bearer "}}

    async def guest(path, header):
        script = f'''import os,urllib.request,urllib.error
assert 'REMOTE_SANDBOX_SPEC_SECRET' not in os.environ
os.environ['no_proxy']=''; os.environ['NO_PROXY']=''
proxy=os.environ.get('https_proxy') or os.environ['HTTPS_PROXY']
handler=urllib.request.ProxyHandler({{'https':proxy}})
request=urllib.request.Request({origin + path!r},headers={{'Authorization':{header!r}}})
try:
    with urllib.request.build_opener(handler).open(request,timeout=8) as response:
        print(response.read().decode())
except urllib.error.URLError:
    print('DENIED')
'''
        return await client.success(py(script), timeoutMs=12000)

    try:
        response = await client.request("PUT", "/proxy/api", headers=headers, json={**original, "allow": [rule]})
        assert response.status == 200, "Start target with the synthetic fixture secret and TLS trust: " + response.text
        allowed = await guest("/echo", PLACEHOLDER)
        assert "credential-roundtrip" in allowed["stdout"], "Target must trust the fixture CA: " + str(allowed)
        assert SYNTHETIC_SECRET not in allowed["stdout"] + allowed["stderr"], "Upstream secret echo leaked"
        assert received == [("/echo", "Bearer " + SYNTHETIC_SECRET)]
        assert (await guest("/echo", "wrong"))["stdout"].strip() == "DENIED"
        assert (await guest("/redirect", PLACEHOLDER))["stdout"].strip() == "DENIED"
        assert received == [("/echo", "Bearer " + SYNTHETIC_SECRET), ("/redirect", "Bearer " + SYNTHETIC_SECRET)]
        snapshot = (await client.request("GET", "/proxy/api", headers=headers)).json()
        assert SYNTHETIC_SECRET not in json.dumps(snapshot)
        assert any(e["origin"] == origin and e["credentialInjected"] for e in snapshot["events"])
    finally:
        await runner.cleanup()
