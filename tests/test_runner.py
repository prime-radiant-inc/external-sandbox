"""Prove the executable fails broken services and marks filtered reports as partial."""
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.mark.parametrize("broken", [False, True])
def test_runner_exit_status_and_report(tmp_path, broken):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = {"mounts": []} if self.path == "/mounts" else {
                "status": "broken" if broken else "ready", "backend": "checker-fixture",
                "architecture": "test", "shell": "/bin/bash", "defaultCwd": "/tmp", "activeCommands": 0, "mounts": []}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    report = tmp_path / "report.json"
    try:
        result = subprocess.run([sys.executable, "-m", "external_sandbox.runner", "--url",
            f"http://127.0.0.1:{server.server_port}", "-k", "test_discovery", "-q", "--report", str(report)],
            capture_output=True, text=True, timeout=30)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
    assert result.returncode == (1 if broken else 0), result.stdout + result.stderr
    data = json.loads(report.read_text())
    assert data["completeSelection"] is False and data["conforms"] is False
    assert data["tests"][0]["outcome"] == ("failed" if broken else "passed")
    assert data["tests"][0]["requirements"] == ["T1"]


def test_missing_profile_prerequisites_are_usage_errors():
    result = subprocess.run([sys.executable, "-m", "external_sandbox.runner", "--url", "http://127.0.0.1:1",
                             "--profile", "mounts", "--collect-only"], capture_output=True, text=True, timeout=20)
    assert result.returncode == 4
    assert "--rw-dir" in result.stderr
