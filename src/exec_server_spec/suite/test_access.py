import aiohttp
import pytest

from exec_server_spec.client import Shell, token


@pytest.mark.contract("T1")
@pytest.mark.parametrize("method,path,headers", [
    ("GET", "/health", {"Origin": "http://evil.invalid"}),
    ("POST", "/exec", {"Origin": "http://evil.invalid"}),
    ("GET", "/mounts", {"Host": "evil.invalid"})])
async def test_http_access_checks(client, method, path, headers):
    response = await client.request(method, path, headers=headers)
    assert response.status == 403, (response.status, response.text)


@pytest.mark.contract("T1")
@pytest.mark.parametrize("path", ["/codex", "/exec/ws"])
async def test_cross_origin_websocket_rejected(client, path):
    with pytest.raises(aiohttp.WSServerHandshakeError) as error:
        await client.ws(path, headers={"Origin": "http://evil.invalid"})
    assert error.value.status == 403


@pytest.mark.browser
@pytest.mark.contract("B1")
async def test_browser_token_handshake_and_execution(client):
    page = await client.request("GET", "/")
    script = await client.request("GET", "/terminal.js")
    assert page.status == script.status == 200
    for response in (page, script):
        assert response.headers["Cache-Control"] == "no-store"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["X-Frame-Options"] == "DENY"
        assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"
    assert "default-src 'none'" in page.headers["Content-Security-Policy"]
    session_token = token(page.text, "terminal-token")
    ws = await client.ws("/exec/ws", headers={"Origin": client.url, "Sec-Fetch-Site": "same-origin"},
                         protocols=["sandbox-terminal", "sandbox-token." + session_token])
    try:
        assert ws.protocol == "sandbox-terminal"
        shell = Shell(client, ws)
        await shell.send(type="start", command="printf browser", stdin=False)
        assert (await shell.finish())["exitCode"] == 0
        assert shell.output["stdout"] == b"browser"
    finally:
        await ws.close()


@pytest.mark.browser
@pytest.mark.contract("B2")
@pytest.mark.parametrize("headers,protocols", [
    ({"Origin": "same"}, []), ({"Origin": "same"}, ["sandbox-terminal", "sandbox-token.wrong"]),
    ({"Sec-Fetch-Site": "same-origin"}, []),
    ({"Origin": "same", "Sec-Fetch-Site": "cross-site"}, [])])
async def test_browser_authorization_rejects_invalid_handshake(client, headers, protocols):
    headers = {k: client.url if v == "same" else v for k, v in headers.items()}
    try:
        ws = await client.ws("/exec/ws", headers=headers, protocols=protocols)
    except aiohttp.WSServerHandshakeError as error:
        assert error.status == 403
    else:
        await ws.close()
        pytest.fail("Unauthorized browser WebSocket was accepted")


@pytest.mark.browser
@pytest.mark.contract("B2")
async def test_browser_pages_and_legacy_routes_reject_origins(client):
    for path in ("/", "/terminal.js"):
        assert (await client.request("GET", path, headers={"Origin": "http://evil.invalid"})).status == 403
    assert (await client.request("POST", "/exec", headers={"Origin": client.url}, json={"command": "true"})).status == 403
    with pytest.raises(aiohttp.WSServerHandshakeError) as error:
        await client.ws("/codex", headers={"Origin": client.url})
    assert error.value.status == 403
