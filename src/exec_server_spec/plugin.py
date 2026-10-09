"""Pytest options, explicit profiles, isolated guest files, and result reporting."""
import asyncio
import json
import shlex
import uuid
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import pytest
import pytest_asyncio

from .client import Client, RPC, validate_url


def pytest_addoption(parser):
    group = parser.getgroup("exec-server-conformance")
    group.addoption("--url", help="Loopback HTTP origin of a dedicated running server")
    group.addoption("--profile", action="append", default=[], choices=["browser", "mounts", "proxy", "proxy-tls"],
                    help="Additional profile to require (repeatable); core always runs")
    group.addoption("--rw-dir", help="Existing writable guest mount directory for mounts profile")
    group.addoption("--ro-dir", help="Existing read-only guest mount directory for mounts profile")
    group.addoption("--proxy-tls-cert", help="Localhost fixture certificate trusted by the target's upstream TLS client")
    group.addoption("--proxy-tls-key", help="Matching disposable private key for the local test upstream")
    group.addoption("--deadline", type=float, default=30, help="Per-operation timeout in seconds (default 30)")
    group.addoption("--report", help="Write a machine-readable JSON report; pytest --junitxml also works")


def pytest_configure(config):
    for name, description in (("browser", "browser terminal protocol"), ("mounts", "read-only/read-write mounts"),
                              ("proxy", "same-host managed proxy management and HTTP forwarding"),
                              ("proxy_tls", "HTTPS credential substitution using a disposable trusted upstream"),
                              ("contract", "SPEC.md requirement identifier")):
        config.addinivalue_line("markers", f"{name}: {description}")
    try:
        config.spec_url = validate_url(config.getoption("--url") or "")
    except ValueError as error:
        raise pytest.UsageError(str(error)) from error
    if config.getoption("--deadline") <= 0:
        raise pytest.UsageError("--deadline must be positive")
    profiles = set(config.getoption("--profile"))
    if "proxy-tls" in profiles:
        profiles.add("proxy")
        config.option.profile = sorted(profiles)
        for option in ("--proxy-tls-cert", "--proxy-tls-key"):
            value = config.getoption(option)
            if not value or not Path(value).is_file():
                raise pytest.UsageError(f"{option} must name an existing fixture file for proxy-tls")
    if "mounts" in profiles:
        for option in ("--rw-dir", "--ro-dir"):
            value = config.getoption(option)
            if not value or not value.startswith("/") or any(c in value for c in "\0\n\r"):
                raise pytest.UsageError(f"{option} must be an existing absolute guest directory")
        if config.getoption("--rw-dir") == config.getoption("--ro-dir"):
            raise pytest.UsageError("Read-only and writable mount directories must differ")
    config.spec_report = {"specRevision": 1, "startedAt": datetime.now(timezone.utc).isoformat(),
                          "url": config.spec_url, "profiles": ["core", *sorted(profiles)], "tests": [], "deselected": 0}


def pytest_collection_modifyitems(config, items):
    profiles = set(config.getoption("--profile"))
    selected, deselected = [], []
    for item in items:
        optional = {profile for marker, profile in (("browser", "browser"), ("mounts", "mounts"),
                    ("proxy", "proxy"), ("proxy_tls", "proxy-tls")) if item.get_closest_marker(marker)}
        (selected if optional <= profiles else deselected).append(item)
    items[:] = selected
    config.spec_report["deselected"] += len(deselected)
    if deselected:
        config.hook.pytest_deselected(items=deselected)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    result = yield
    report = result.get_result()
    if report.when == "call" or report.failed or report.skipped:
        item.config.spec_report["tests"].append({"id": item.name, "phase": report.when,
            "outcome": report.outcome, "seconds": round(report.duration, 4),
            "requirements": [m.args[0] for m in item.iter_markers("contract")],
            **({"failure": str(report.longrepr)} if report.failed else {})})


def pytest_sessionfinish(session, exitstatus):
    report = session.config.spec_report
    report["exitCode"] = int(exitstatus)
    report["finishedAt"] = datetime.now(timezone.utc).isoformat()
    report["completeSelection"] = not (session.config.getoption("-k") or session.config.getoption("-m")
                                       or session.config.getoption("--collect-only"))
    report["conforms"] = (int(exitstatus) == 0 and report["completeSelection"]
                          and bool(report["tests"]) and all(t["outcome"] == "passed" for t in report["tests"]))
    path = session.config.getoption("--report")
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, indent=2) + "\n")


@pytest_asyncio.fixture
async def client(request):
    deadline = request.config.getoption("--deadline")
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=deadline), trust_env=False) as session:
        yield Client(session, request.config.spec_url, deadline)


@pytest_asyncio.fixture
async def rpc(client):
    ws = await client.ws("/codex")
    connection = RPC(client, ws)
    try:
        await connection.initialize()
        connection.python = (await client.success("command -v python3"))["stdout"].strip()
        assert connection.python.startswith("/"), "Guest Python 3 is required"
        yield connection
    finally:
        await ws.close()


@pytest_asyncio.fixture
async def space(client):
    path = "/tmp/exec-server-spec-" + uuid.uuid4().hex
    await client.success("mkdir -m 700 -- " + shlex.quote(path))
    try:
        yield path
    finally:
        await client.success("rm -rf -- " + shlex.quote(path))


@pytest_asyncio.fixture
async def idle(client):
    async def wait():
        async with asyncio.timeout(client.deadline):
            while True:
                response = await client.request("GET", "/health")
                assert response.status == 200, response.text
                if response.json()["activeCommands"] == 0:
                    return
                await asyncio.sleep(0.05)
    await wait()
    yield wait
    await wait()
