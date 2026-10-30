"""Wire clients with bounded waits, strict bytes, and interleaved RPC handling."""
import asyncio
import base64
import json
import shlex
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit

import aiohttp


def validate_url(value):
    p = urlsplit(value)
    if (p.scheme != "http" or p.hostname not in {"localhost", "127.0.0.1", "::1"}
            or p.username or p.password or p.path not in {"", "/"} or p.query or p.fragment):
        raise ValueError("--url must be a loopback http:// origin without a path, credentials, query, or fragment")
    if p.port is not None and not 1 <= p.port <= 65535:
        raise ValueError("Invalid server port")
    return value.rstrip("/")


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(value):
    assert isinstance(value, str), value
    data = base64.b64decode(value, validate=True)
    assert b64(data) == value, "Noncanonical base64"
    return data


def uri(path):
    assert path.startswith("/")
    return "file://" + quote(path, safe="/!~*'()")


def py(code):
    return "python3 -c " + shlex.quote(code)


def result_shape(value, buffered=True):
    for key in ("timedOut", "outputLimitExceeded"):
        assert type(value[key]) is bool, value
    assert type(value["durationMs"]) in (int, float) and value["durationMs"] >= 0, value
    assert (value["exitCode"] is None) != (value["signal"] is None), value
    for key in ("exitCode", "signal"):
        assert value[key] is None or type(value[key]) is int, value
    if buffered:
        assert isinstance(value["stdout"], str) and isinstance(value["stderr"], str), value


def assert_fields(actual, expected):
    """Require specified fields while allowing forward-compatible response additions."""
    assert isinstance(actual, dict), actual
    for key, value in expected.items():
        assert key in actual, (key, actual)
        if isinstance(value, dict):
            assert_fields(actual[key], value)
        else:
            assert actual[key] == value and (not isinstance(value, bool) or type(actual[key]) is bool), (key, actual[key], value)


class Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and "name" in attrs:
            self.values[attrs["name"]] = attrs.get("content")


def token(html, name):
    parser = Meta()
    parser.feed(html)
    value = parser.values.get(name)
    assert isinstance(value, str) and value, f"Missing {name} meta tag"
    return value


@dataclass
class Reply:
    status: int
    headers: dict
    text: str

    def json(self):
        return json.loads(self.text)


class Client:
    def __init__(self, session, url, deadline):
        self.session, self.url, self.deadline = session, url, deadline

    async def request(self, method, path, **kwargs):
        async with self.session.request(method, self.url + path, allow_redirects=False, **kwargs) as response:
            return Reply(response.status, dict(response.headers), await response.text())

    async def execute(self, command, **kwargs):
        response = await self.request("POST", "/exec", json={"command": command, **kwargs})
        assert response.status == 200, (response.status, response.text)
        result = response.json()
        result_shape(result)
        return result

    async def success(self, command, **kwargs):
        result = await self.execute(command, **kwargs)
        assert result["exitCode"] == 0 and not result["timedOut"] and not result["outputLimitExceeded"], result
        return result

    async def ws(self, path, **kwargs):
        return await asyncio.wait_for(self.session.ws_connect(self.url + path, max_msg_size=16 * 1024 * 1024,
                                                             **kwargs), self.deadline)

    async def receive(self, ws):
        message = await asyncio.wait_for(ws.receive(), self.deadline)
        assert message.type == aiohttp.WSMsgType.TEXT, f"Expected JSON text; got {message.type}: {message.data}"
        value = json.loads(message.data)
        assert isinstance(value, dict), value
        return value


class Shell:
    def __init__(self, client, ws):
        self.client, self.ws = client, ws
        self.events = []
        self.output = {"stdout": bytearray(), "stderr": bytearray()}
        self.exited = False

    async def send(self, **value):
        await self.ws.send_json(value)

    async def event(self):
        value = await self.client.receive(self.ws)
        kind = value.get("type")
        assert kind in {"started", "stdout", "stderr", "stdin_ack", "stdin_closed", "exit", "error"}, value
        assert not self.exited, "Event after terminal result"
        if not self.events:
            assert kind in {"started", "error"}, value
        if kind == "started":
            assert not self.events and isinstance(value["processId"], str), value
        if kind in self.output:
            self.output[kind].extend(unb64(value["data"]))
        if kind == "exit":
            result_shape(value, buffered=False)
            self.exited = True
        if kind == "error":
            assert isinstance(value.get("error"), str) and value["error"], value
            self.exited = True
        self.events.append(value)
        return value

    async def until(self, kind, **fields):
        async with asyncio.timeout(self.client.deadline):
            while True:
                event = await self.event()
                if event["type"] == kind and all(event.get(k) == v for k, v in fields.items()):
                    return event
                assert event["type"] not in {"exit", "error"}, event

    async def finish(self):
        event = await self.until("exit")
        await self.closed(normal=True)
        return event

    async def closed(self, normal=False):
        message = await asyncio.wait_for(self.ws.receive(), self.client.deadline)
        assert message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED}, message
        if normal:
            assert self.ws.close_code == 1000, self.ws.close_code


class RPCError(Exception):
    def __init__(self, detail):
        self.detail = detail
        super().__init__(str(detail))


class RPC:
    def __init__(self, client, ws):
        self.client, self.ws = client, ws
        self.next_id = 1
        self.notifications = []
        self.info = None

    async def notify(self, method, params=None):
        await self.ws.send_json({"method": method, "params": params or {}})

    async def call(self, method, params=None):
        request_id = self.next_id
        self.next_id += 1
        await self.ws.send_json({"id": request_id, "method": method, "params": params or {}})
        async with asyncio.timeout(self.client.deadline):
            while True:
                message = await self.client.receive(self.ws)
                if "id" not in message:
                    self.notifications.append(message)
                    continue
                assert message["id"] == request_id, message
                assert ("result" in message) != ("error" in message), message
                if "error" in message:
                    error = message["error"]
                    assert type(error["code"]) is int and isinstance(error["message"], str), error
                    raise RPCError(error)
                assert isinstance(message["result"], dict), message
                return message["result"]

    async def initialize(self):
        result = await self.call("initialize", {"clientName": "external-sandbox"})
        assert isinstance(result["sessionId"], str) and result["sessionId"], result
        self.info = result["environmentInfo"]
        await self.notify("initialized")
        return result

    async def start(self, process_id, argv, **kwargs):
        params = {"processId": process_id, "argv": argv, "cwd": self.info["cwd"], "env": {},
                  "tty": False, **kwargs}
        result = await self.call("process/start", params)
        assert_fields(result, {"processId": process_id, "sandboxType": "none"})
        assert not [n for n in self.notifications if n.get("params", {}).get("processId") == process_id], "Output before start response"
        return result

    async def complete(self, process_id):
        async with asyncio.timeout(self.client.deadline):
            while not any(n.get("method") == "process/closed" and n.get("params", {}).get("processId") == process_id
                          for n in self.notifications):
                message = await self.client.receive(self.ws)
                assert "id" not in message, message
                self.notifications.append(message)
        events = [n for n in self.notifications if n.get("params", {}).get("processId") == process_id]
        methods = [n["method"] for n in events]
        assert methods[-2:] == ["process/exited", "process/closed"], methods
        assert all(m == "process/output" for m in methods[:-2]), methods
        seqs = [n["params"]["seq"] for n in events]
        assert seqs == list(range(1, len(seqs) + 1)), seqs
        output = {"stdout": bytearray(), "stderr": bytearray()}
        for event in events[:-2]:
            p = event["params"]
            assert p["stream"] in output, p
            output[p["stream"]].extend(unb64(p["chunk"]))
        assert events[-2]["params"]["sandboxDenied"] is False
        return output, events[-2]["params"]["exitCode"], events
