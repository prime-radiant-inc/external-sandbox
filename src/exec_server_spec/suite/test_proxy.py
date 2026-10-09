"""Requires a dedicated proxy-enabled server on the same host as this runner."""
import asyncio
import copy
import json
import uuid

from aiohttp import web
import pytest
import pytest_asyncio

from exec_server_spec.client import py, token

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
                                 ("{}", {"Content-Type": "application/json", "Content-Encoding": "gzip"}, 415),
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
