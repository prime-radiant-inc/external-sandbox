"""The checker must reject broken peers rather than manufacture passing results."""
import json
from types import SimpleNamespace

import aiohttp
import pytest

from external_sandbox.client import Client, RPC, RPCError, Shell, result_shape, token, unb64, validate_url


class Socket:
    def __init__(self, messages):
        self.messages = list(messages)
        self.sent = []
        self.close_code = 1000

    async def receive(self):
        value = self.messages.pop(0)
        if value is None:
            return SimpleNamespace(type=aiohttp.WSMsgType.CLOSE, data=1000)
        return SimpleNamespace(type=aiohttp.WSMsgType.TEXT, data=json.dumps(value))

    async def send_json(self, value):
        self.sent.append(value)


@pytest.mark.parametrize("url", ["https://127.0.0.1", "http://example.com", "http://localhost/path", "http://user@localhost", "http://localhost?token=x"])
def test_nonlocal_or_ambiguous_urls_rejected(url):
    with pytest.raises(ValueError):
        validate_url(url)


@pytest.mark.parametrize("value", ["YQ", "YR==", "YQ==\n", "%%%%"])
def test_invalid_base64_rejected(value):
    with pytest.raises((AssertionError, ValueError)):
        unb64(value)


def test_tokens_are_parsed_independent_of_attribute_order():
    assert token('<meta content="a&amp;b" name="terminal-token">', "terminal-token") == "a&b"
    with pytest.raises(AssertionError):
        token("<html></html>", "terminal-token")


@pytest.mark.parametrize("events", [
    [{"type": "stdout", "data": "eA=="}],
    [{"type": "started", "processId": "1"}, None],
    [{"type": "error", "error": "broken"}]])
async def test_shell_rejects_wrong_order_premature_close_and_error(events):
    checker = Shell(Client(None, "http://localhost", 1), Socket(events))
    with pytest.raises(AssertionError):
        await checker.finish()


async def test_rpc_preserves_notifications_while_matching_response_ids():
    notification = {"method": "process/output", "params": {"processId": "p", "seq": 1, "stream": "stdout", "chunk": "eA=="}}
    rpc = RPC(Client(None, "http://localhost", 1), Socket([notification, {"id": 1, "result": {"ok": True}}]))
    assert await rpc.call("test") == {"ok": True}
    assert rpc.notifications == [notification]


async def test_rpc_mismatched_response_is_failure():
    rpc = RPC(Client(None, "http://localhost", 1), Socket([{"id": 2, "result": {}}]))
    with pytest.raises(AssertionError):
        await rpc.call("test")


async def test_rpc_error_is_not_success():
    rpc = RPC(Client(None, "http://localhost", 1), Socket([{"id": 1, "error": {"code": -32601, "message": "bad"}}]))
    with pytest.raises(RPCError):
        await rpc.call("test")


def test_exit_must_have_exactly_one_status():
    result = {"stdout": "", "stderr": "", "timedOut": False, "outputLimitExceeded": False,
              "durationMs": 0, "exitCode": 0, "signal": 9}
    with pytest.raises(AssertionError):
        result_shape(result)


def test_additional_response_fields_are_allowed():
    from external_sandbox.client import assert_fields
    assert_fields({"status": "ready", "extension": 1}, {"status": "ready"})
    with pytest.raises(AssertionError):
        assert_fields({"ready": 1}, {"ready": True})


def test_tls_fixture_is_disposable_and_refuses_overwrite(tmp_path):
    import stat
    from cryptography import x509
    from external_sandbox.tls_fixture import generate
    directory = generate(tmp_path / "tls")
    cert = x509.load_pem_x509_certificate((directory / "cert.pem").read_bytes())
    assert "127.0.0.1" in str(cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value)
    assert stat.S_IMODE((directory / "key.pem").stat().st_mode) == 0o600
    original = (directory / "cert.pem").read_bytes()
    with pytest.raises(ValueError, match="already exist"):
        generate(directory)
    assert (directory / "cert.pem").read_bytes() == original
