import shlex
import uuid

import pytest

from external_sandbox.client import RPCError, b64, unb64, uri

pytestmark = [pytest.mark.mounts, pytest.mark.contract("M1")]


async def test_mount_modes_through_shell_and_filesystem(client, rpc, request):
    rw, ro = (request.config.getoption(name).rstrip("/") for name in ("--rw-dir", "--ro-dir"))
    response = await client.request("GET", "/mounts")
    assert response.status == 200
    mounts = response.json()["mounts"]
    for path, mode in ((rw, "rw"), (ro, "ro")):
        assert any(m["mode"] == mode and path == m["guestPath"] for m in mounts), (path, mode, mounts)
    name = "external-sandbox-" + uuid.uuid4().hex
    rwfile, rofile = rw + "/" + name, ro + "/" + name
    try:
        await rpc.call("fs/writeFile", {"path": uri(rwfile), "dataBase64": b64(b"rpc")})
        assert (await client.success("cat " + shlex.quote(rwfile)))["stdout"] == "rpc"
        await client.success("printf shell > " + shlex.quote(rwfile))
        assert unb64((await rpc.call("fs/readFile", {"path": uri(rwfile)}))["dataBase64"]) == b"shell"
        # Distinguish EROFS from a merely nonexistent path by verifying the directory exists first.
        metadata = await rpc.call("fs/getMetadata", {"path": uri(ro)})
        assert metadata["isDirectory"] is True
        result = await client.execute("printf forbidden > " + shlex.quote(rofile))
        assert result["exitCode"] != 0, result
        with pytest.raises(RPCError):
            await rpc.call("fs/writeFile", {"path": uri(rofile), "dataBase64": b64(b"forbidden")})
        await client.success("test ! -e " + shlex.quote(rofile))
    finally:
        # Unique filenames only; also clean up if a broken server allowed the forbidden write.
        await client.success("rm -f -- " + shlex.quote(rwfile))
        await client.execute("if test -e " + shlex.quote(rofile) + "; then rm -f -- " + shlex.quote(rofile) + "; fi")
