import shlex

import pytest

from external_sandbox.client import assert_fields, RPCError, b64, unb64, uri


@pytest.mark.contract("F1")
async def test_file_roundtrip_metadata_directory_and_canonicalization(rpc, space):
    path = uri(space + "/unicode é file.bin")
    data = bytes(range(256)) * 300
    assert_fields(await rpc.call("fs/writeFile", {"path": path, "dataBase64": b64(data)}), {})
    assert unb64((await rpc.call("fs/readFile", {"path": path}))["dataBase64"]) == data
    meta = await rpc.call("fs/getMetadata", {"path": path})
    assert meta["isFile"] is True and meta["isDirectory"] is False and meta["isSymlink"] is False
    assert meta["size"] == len(data)
    assert all(type(meta[k]) in (int, float) and meta[k] >= 0 for k in ("createdAtMs", "modifiedAtMs"))
    entries = (await rpc.call("fs/readDirectory", {"path": uri(space)}))["entries"]
    assert {e["fileName"] for e in entries} == {"unicode é file.bin"}
    assert entries[0]["isFile"] is True and entries[0]["isDirectory"] is False
    assert (await rpc.call("fs/canonicalize", {"path": path}))["path"] == path
    await rpc.call("fs/writeFile", {"path": path, "dataBase64": ""})
    assert (await rpc.call("fs/readFile", {"path": path}))["dataBase64"] == ""


@pytest.mark.contract("F2")
async def test_immutable_snapshot_offsets_close_and_session_scope(rpc, client, space):
    path = uri(space + "/snapshot")
    await rpc.call("fs/writeFile", {"path": path, "dataBase64": b64(b"original")})
    assert_fields(await rpc.call("fs/open", {"path": path, "handleId": "snapshot"}), {"handleId": "snapshot"})
    with pytest.raises(RPCError):
        await rpc.call("fs/open", {"path": path, "handleId": "snapshot"})
    await rpc.call("fs/writeFile", {"path": path, "dataBase64": b64(b"changed")})
    assert_fields(await rpc.call("fs/readBlock", {"handleId": "snapshot", "offset": 0, "len": 3}), {"chunk": b64(b"ori"), "eof": False})
    assert_fields(await rpc.call("fs/readBlock", {"handleId": "snapshot", "offset": 3, "len": 99}), {"chunk": b64(b"ginal"), "eof": True})
    assert_fields(await rpc.call("fs/readBlock", {"handleId": "snapshot", "offset": 99, "len": 2}), {"chunk": "", "eof": True})
    assert_fields(await rpc.call("fs/readBlock", {"handleId": "snapshot", "offset": 0, "len": 0}), {"chunk": "", "eof": False})
    from external_sandbox.client import RPC
    ws = await client.ws("/codex")
    try:
        other = RPC(client, ws)
        await other.initialize()
        with pytest.raises(RPCError):
            await other.call("fs/readBlock", {"handleId": "snapshot", "offset": 0, "len": 3})
    finally:
        await ws.close()
    assert_fields(await rpc.call("fs/close", {"handleId": "snapshot"}), {})
    assert_fields(await rpc.call("fs/close", {"handleId": "snapshot"}), {})
    with pytest.raises(RPCError):
        await rpc.call("fs/readBlock", {"handleId": "snapshot", "offset": 0, "len": 1})


@pytest.mark.contract("F3")
async def test_directories_copy_walk_and_remove(rpc, client, space):
    root = uri(space)
    directory = uri(space + "/tree/sub")
    await rpc.call("fs/createDirectory", {"path": directory})
    file = uri(space + "/tree/sub/file")
    await rpc.call("fs/writeFile", {"path": file, "dataBase64": b64(b"copy")})
    await client.success("chmod 755 " + shlex.quote(space + "/tree/sub/file"))
    target = uri(space + "/copied")
    await rpc.call("fs/copy", {"sourcePath": uri(space + "/tree"), "destinationPath": target, "recursive": True})
    assert unb64((await rpc.call("fs/readFile", {"path": target + "/sub/file"}))["dataBase64"]) == b"copy"
    await client.success("test -x " + shlex.quote(space + "/copied/sub/file"))
    walk = await rpc.call("fs/walk", {"path": root, "options": {"maxDepth": 10, "maxDirectories": 100, "maxEntries": 100}})
    assert walk["errors"] == [] and walk["truncated"] is False
    assert {(e["path"], e["kind"]) for e in walk["entries"]} == {
        (uri(space + suffix), kind) for suffix, kind in [("/tree", "directory"), ("/tree/sub", "directory"),
        ("/tree/sub/file", "file"), ("/copied", "directory"), ("/copied/sub", "directory"), ("/copied/sub/file", "file")]}
    limited = await rpc.call("fs/walk", {"path": root, "options": {"maxDepth": 0, "maxDirectories": 1, "maxEntries": 1}})
    assert limited["truncated"] is True and len(limited["entries"]) <= 1
    with pytest.raises(RPCError):
        await rpc.call("fs/remove", {"path": target, "recursive": False})
    await rpc.call("fs/remove", {"path": target})
    await rpc.call("fs/remove", {"path": target})
    with pytest.raises(RPCError):
        await rpc.call("fs/remove", {"path": target, "force": False})
    with pytest.raises(RPCError):
        await rpc.call("fs/copy", {"sourcePath": file, "destinationPath": file, "recursive": False})


@pytest.mark.contract("F4")
async def test_symlink_and_hidden_walk_semantics(rpc, client, space):
    await client.success("mkdir -p .hidden dir; printf target > dir/file; printf hidden > .hidden/file; ln -s dir link; ln -s dir/file filelink", cwd=space)
    link = uri(space + "/filelink")
    meta = await rpc.call("fs/getMetadata", {"path": link, "followSymlinks": False})
    assert meta["isSymlink"] is True and meta["isFile"] is False
    assert (await rpc.call("fs/canonicalize", {"path": link}))["path"] == uri(space + "/dir/file")
    assert unb64((await rpc.call("fs/readFile", {"path": link}))["dataBase64"]) == b"target"
    for path in (link, uri(space + "/link/file")):
        with pytest.raises(RPCError):
            await rpc.call("fs/readFile", {"path": path, "followSymlinks": False})
        with pytest.raises(RPCError):
            await rpc.call("fs/writeFile", {"path": path, "dataBase64": b64(b"wrong"), "followSymlinks": False})
    assert unb64((await rpc.call("fs/readFile", {"path": link}))["dataBase64"]) == b"target"
    with pytest.raises(RPCError):
        await rpc.call("fs/copy", {"sourcePath": link, "destinationPath": uri(space + "/copy"), "recursive": False})
    walk = await rpc.call("fs/walk", {"path": uri(space), "options": {
        "maxDepth": 10, "maxDirectories": 100, "maxEntries": 100, "pruneHiddenDirectories": True}})
    paths = {e["path"] for e in walk["entries"]}
    assert uri(space + "/.hidden") in paths and uri(space + "/.hidden/file") not in paths
    assert link not in paths and uri(space + "/link") not in paths
    await rpc.call("fs/remove", {"path": link})
    assert unb64((await rpc.call("fs/readFile", {"path": uri(space + "/dir/file")}))["dataBase64"]) == b"target"


@pytest.mark.contract("F5")
@pytest.mark.parametrize("path", ["/tmp/file", "http://localhost/tmp/file", "file://other/tmp/file", "file:///tmp/x?query",
    "file:///tmp/x#fragment", "file:///tmp/%2fetc", "file:///tmp/%zz", "file:///tmp/%00", "file:///tmp/\\x"],
    ids=["path-not-uri", "scheme", "authority", "query", "fragment", "encoded-slash", "escape", "control", "backslash"])
async def test_invalid_file_uris(rpc, path):
    with pytest.raises(RPCError):
        await rpc.call("fs/readFile", {"path": path})
    assert_fields(await rpc.call("environment/status"), {"status": "ready"})


@pytest.mark.contract("F5")
async def test_filesystem_errors_are_explicit(rpc, space):
    path = uri(space + "/missing")
    with pytest.raises(RPCError) as error:
        await rpc.call("fs/readFile", {"path": path})
    assert error.value.detail["code"] == -32004
    with pytest.raises(RPCError):
        await rpc.call("fs/writeFile", {"path": path, "dataBase64": "YR=="})
    with pytest.raises(RPCError):
        await rpc.call("fs/readFile", {"path": uri(space)})
    with pytest.raises(RPCError):
        await rpc.call("fs/not-implemented", {"path": uri(space)})
