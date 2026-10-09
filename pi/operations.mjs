import { posix as path } from "node:path";

// This module performs no host filesystem access. Python and rg run in the guest;
// user supplied paths, patterns, and contents travel as JSON, never shell source.
export const GUEST_HELPER = String.raw`
import base64, errno, fnmatch, json, os, pathlib, stat, subprocess, sys, tempfile

def text_field(value):
    if "text" in value:
        return value["text"]
    return base64.b64decode(value.get("bytes", "")).decode("utf-8", "replace")

def matches_glob(name, pattern):
    # Filter rg's already ignore-aware results. Passing a positive --glob to rg
    # would override .gitignore and unexpectedly include ignored files.
    negative = pattern.startswith("!")
    if negative: pattern = pattern[1:]
    if pattern.startswith("/"): pattern = pattern[1:]
    candidate = pathlib.PurePosixPath(name)
    matched = (fnmatch.fnmatchcase(candidate.name, pattern) if "/" not in pattern
               else candidate.full_match(pattern))
    return not matched if negative else matched

def run(request):
    operation = request["operation"]
    p = request.get("path")
    if operation == "read":
        with open(p, "rb") as f:
            data = f.read(12 * 1024 * 1024 - 4096 + 1)
        if len(data) > 12 * 1024 * 1024 - 4096:
            raise ValueError("File exceeds remote read limit (just under 12 MiB); use bash to read a portion")
        return base64.b64encode(data).decode("ascii")
    if operation == "write":
        with open(p, "wb") as f:
            f.write(base64.b64decode(request["data"], validate=True))
        return None
    if operation == "mkdir":
        os.makedirs(p, exist_ok=True)
        return None
    if operation == "access":
        os.stat(p)
        if not os.access(p, os.R_OK):
            raise PermissionError(errno.EACCES, "File is not readable", p)
        return None
    if operation == "exists":
        return os.path.exists(p)
    if operation == "stat":
        result = os.stat(p)
        return {"isDirectory": stat.S_ISDIR(result.st_mode), "size": result.st_size}
    if operation == "readdir":
        return os.listdir(p)
    if operation == "mime":
        with open(p, "rb") as f:
            head = f.read(16)
        if head.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
        if head.startswith(b"\xff\xd8\xff"): return "image/jpeg"
        if head.startswith((b"GIF87a", b"GIF89a")): return "image/gif"
        if head.startswith(b"RIFF") and head[8:12] == b"WEBP": return "image/webp"
        if head.startswith(b"BM"): return "image/bmp"
        return None
    if operation == "glob":
        pattern = request["pattern"]
        args = ["rg", "--files", "--null", "--hidden", "--no-require-git", "--color=never"]
        for ignored in request.get("ignore", []):
            args += ["--glob", "!" + ignored]
        args += ["--", "."]
        found = []
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(args, cwd=p, stdout=subprocess.PIPE, stderr=errors)
            limited = False
            try:
                pending = b""
                while chunk := child.stdout.read1(65536):
                    pending += chunk
                    while b"\0" in pending:
                        item, pending = pending.split(b"\0", 1)
                        name = os.fsdecode(item)
                        if name.startswith("./"): name = name[2:]
                        if matches_glob(name, pattern):
                            found.append(name)
                            if len(found) >= request["limit"]:
                                limited = True
                                break
                    if limited: break
            finally:
                if limited: child.terminate()
                child.stdout.close()
                code = child.wait()
            if not limited and code not in (0, 1):
                errors.seek(0)
                raise RuntimeError(errors.read(65536).decode("utf-8", "replace") or "rg failed")
        return sorted(found)
    if operation == "grep":
        os.stat(p)
        is_directory = os.path.isdir(p)
        args = ["rg", "--json", "--line-number", "--color=never", "--hidden", "--no-require-git"]
        if request.get("ignoreCase"): args.append("--ignore-case")
        if request.get("literal"): args.append("--fixed-strings")
        if request["context"]: args += ["--context", str(request["context"])]
        args += ["--", request["pattern"], p]
        rows, count, size = [], 0, 0
        limited, byte_limited, lines_truncated = False, False, False
        with tempfile.TemporaryFile() as errors:
            child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
            try:
                for raw in child.stdout:
                    event = json.loads(raw)
                    kind = event["type"]
                    if kind not in ("match", "context"): continue
                    data = event["data"]
                    filename = text_field(data["path"])
                    display = os.path.relpath(filename, p) if is_directory else os.path.basename(filename)
                    if request.get("glob") and not matches_glob(display, request["glob"]): continue
                    if kind == "match":
                        count += 1
                        if count > request["limit"]:
                            limited = True
                            break
                    content = text_field(data["lines"]).rstrip("\r\n")
                    if len(content) > 500:
                        content = content[:500] + "... [truncated]"
                        lines_truncated = True
                    separator = ":" if kind == "match" else "-"
                    row = display + separator + str(data["line_number"]) + separator + " " + content
                    rows.append(row)
                    size += len(row.encode("utf-8")) + 1
                    # Keep bounded output before the host applies Pi's 50 KiB display limit.
                    if size > 52 * 1024:
                        byte_limited = True
                        break
            finally:
                if limited or byte_limited: child.terminate()
                child.stdout.close()
                code = child.wait()
            if not limited and not byte_limited and code not in (0, 1):
                errors.seek(0)
                raise RuntimeError(errors.read(65536).decode("utf-8", "replace") or "rg failed")
        return {"rows": rows, "matchLimitReached": limited, "byteLimitReached": byte_limited,
                "linesTruncated": lines_truncated}
    raise ValueError("Unknown guest operation: " + operation)

try:
    result = run(json.load(sys.stdin))
    print(json.dumps({"ok": True, "value": result}, ensure_ascii=True))
except Exception as error:
    print(json.dumps({"ok": False, "error": str(error),
                      "code": errno.errorcode.get(getattr(error, "errno", None))}, ensure_ascii=True))
`;

const HELPER_COMMAND = `python3 -c '${GUEST_HELPER.replaceAll("'", "'\\''")}'`;

export function resolveGuestPath(value, cwd, home = "/root") {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid guest path");
  if (!path.isAbsolute(cwd) || !path.isAbsolute(home)) throw new Error("Guest cwd and home must be absolute");
  let name = value.startsWith("@") ? value.slice(1) : value;
  if (name === "~") name = home;
  else if (name.startsWith("~/")) name = path.join(home, name.slice(2));
  return path.resolve(cwd, name || ".");
}

async function request(client, data, { cwd, signal }) {
  if (signal?.aborted) throw new Error("Operation aborted");
  const result = await client.exec(HELPER_COMMAND, {
    cwd, signal, stdin: JSON.stringify(data), timeoutMs: 120000,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || `Guest helper exited with code ${result.exitCode}`);
  }
  let payload;
  try { payload = JSON.parse(result.stdout.toString("utf8")); }
  catch { throw new Error("Invalid or incomplete guest filesystem response"); }
  if (payload.ok !== true) {
    const error = new Error(payload.error || "Guest filesystem operation failed");
    if (payload.code) error.code = payload.code;
    throw error;
  }
  return payload.value;
}

export function createRemoteOperations(client, { cwd, home = "/root", signal } = {}) {
  const resolve = (p) => resolveGuestPath(p, cwd, home);
  const call = (operation, p, extra = {}) => request(client, { operation, path: resolve(p), ...extra }, { cwd, signal });
  const readOps = {
    readFile: async (p) => Buffer.from(await call("read", p), "base64"),
    access: async (p) => { await call("access", p); },
    detectImageMimeType: (p) => call("mime", p),
  };
  const writeOps = {
    writeFile: async (p, content) => { await call("write", p, { data: Buffer.from(content).toString("base64") }); },
    mkdir: async (p) => { await call("mkdir", p); },
  };
  const lsOps = {
    exists: (p) => call("exists", p),
    stat: async (p) => {
      const result = await call("stat", p);
      return { isDirectory: () => result.isDirectory, size: result.size };
    },
    readdir: (p) => call("readdir", p),
  };
  const findOps = {
    exists: lsOps.exists,
    glob: (pattern, p, options) => call("glob", p, {
      pattern, ignore: options.ignore, limit: positiveInteger(options.limit, "limit", 1000),
    }),
  };
  return { readOps, writeOps, editOps: { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile }, lsOps, findOps };
}

function positiveInteger(value, name, fallback, minimum = 1) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return number;
}

export async function executeGrep(client, params, { cwd, home = "/root", signal } = {}) {
  if (typeof params.pattern !== "string") throw new Error("pattern must be a string");
  const limit = positiveInteger(params.limit, "limit", 100);
  const context = positiveInteger(params.context, "context", 0, 0);
  const result = await request(client, {
    ...params, operation: "grep", path: resolveGuestPath(params.path ?? ".", cwd, home), limit, context,
  }, { cwd, signal });
  if (!result.rows.length) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  const all = result.rows.join("\n");
  const rows = [];
  let bytes = 0;
  for (const row of result.rows) {
    const additional = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + additional > 50 * 1024) break;
    rows.push(row);
    bytes += additional;
  }
  let output = rows.join("\n");
  const details = {};
  const notices = [];
  if (result.matchLimitReached) {
    details.matchLimitReached = limit;
    notices.push(`${limit} matches limit reached. Increase limit or refine pattern`);
  }
  if (rows.length < result.rows.length || result.byteLimitReached) {
    details.truncation = {
      content: output, truncated: true, truncatedBy: "bytes", totalLines: result.rows.length,
      totalBytes: Buffer.byteLength(all), outputLines: rows.length, outputBytes: bytes,
      lastLinePartial: false, firstLineExceedsLimit: rows.length === 0,
      maxLines: Number.MAX_SAFE_INTEGER, maxBytes: 50 * 1024,
    };
    notices.push("50.0KB limit reached. Refine the search to see more");
  }
  if (result.linesTruncated) {
    details.linesTruncated = true;
    notices.push("Some lines truncated to 500 chars. Use read to see full lines");
  }
  if (notices.length) output += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text: output }], details: notices.length ? details : undefined };
}
