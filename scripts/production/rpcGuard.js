/**
 * Who may talk to a local signer (plan v2 Task 5.15; the lead's security
 * requirement after a scanner flagged it): scripts/production/signer.js
 * and, with the dev-node methods allowed, scripts/ci/remote-signer.js.
 * A signer on 127.0.0.1 is otherwise reachable by any web page in the
 * operator's browser (a cross-site POST, or a hostname rebound to
 * 127.0.0.1), which could have it sign. So every request must:
 *  - be a POST with Content-Type application/json, and no Origin or
 *    Referer header (a browser sends one on every cross-site request; an
 *    OPTIONS preflight gets 403 and no Access-Control-Allow-* header ever);
 *  - name the signer by Host: 127.0.0.1:<port> or localhost:<port> (DNS
 *    rebinding);
 *  - carry `Authorization: Bearer <token>`, the random 32-byte token the
 *    signer wrote at start to a 0600 file (SIGNER_TOKEN_FILE, default
 *    tokenFileFor(port): this user's 0700 directory under the temp dir);
 *    compared in constant time. The CLIs send it through the `remote`
 *    network's httpHeaders (hardhat.config.ts), reading it only from a
 *    file this user owns with mode 0600 (readToken);
 *  - stay under MAX_BODY and call an allowed JSON-RPC method.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BODY = 2 * 1024 * 1024;
/** Reads forwarded to the chain, besides the signer's own methods. */
const READS = [
  "eth_chainId",
  "net_version",
  "web3_clientVersion",
  "eth_syncing",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
];
const OWN = [
  "eth_accounts",
  "eth_sendTransaction",
  "personal_sign",
  "eth_sign",
  "vanguard_signClaim",
  "vanguard_bump",
];

/** Refuse anything but this user's own plain file or dir, no group/other bits. */
function ownedPrivate(p, dir = false) {
  const st = fs.lstatSync(p);
  const kind = dir ? st.isDirectory() : st.isFile();
  if (!kind || st.uid !== process.getuid() || st.mode & 0o077) {
    throw new Error(
      `${p} must be this user's own ${dir ? "directory, mode 0700" : "file, mode 0600"} (review L-3): refusing`,
    );
  }
}

/**
 * The token file for a signer on `port`: SIGNER_TOKEN_FILE, else
 * <tmp>/vanguard-signer-<uid>/<port>.token in this user's 0700 directory
 * (made when `make`, checked always).
 */
function tokenFileFor(port, env = process.env, make = false) {
  if (env.SIGNER_TOKEN_FILE) return env.SIGNER_TOKEN_FILE;
  const d = path.join(os.tmpdir(), `vanguard-signer-${process.getuid()}`);
  if (make) {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  if (fs.existsSync(d)) ownedPrivate(d, true);
  return path.join(d, `${port}.token`);
}

/** The token in `file`, refused unless the file is this user's, 0600. */
function readToken(file) {
  ownedPrivate(file);
  return fs.readFileSync(file, "utf8").trim();
}

/**
 * A fresh token written to `file` (owner-only, created anew: an existing
 * file is replaced only if this user owns it). Returns the token.
 */
function writeToken(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.uid !== process.getuid() || !st.isFile()) {
      throw new Error(
        `${file} exists and is not this user's plain file: refusing`,
      );
    }
    fs.unlinkSync(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const token = crypto.randomBytes(32).toString("hex");
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return token;
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

/**
 * Why `req` (headers read only) is refused, as [status, message], or null.
 * `port` is the signer's own; `token` its secret.
 */
function refusal(req, port, token) {
  const h = req.headers;
  if (req.method === "OPTIONS") return [403, "no cross-origin requests"];
  if (req.method !== "POST") return [405, "POST only"];
  if (h.origin !== undefined || h.referer !== undefined) {
    return [
      403,
      "a request with Origin or Referer (a browser page) is refused",
    ];
  }
  if (!/^application\/json(\s*;|$)/i.test(String(h["content-type"] || ""))) {
    return [415, "Content-Type must be application/json"];
  }
  const host = String(h.host || "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return [403, `Host must be 127.0.0.1:${port} or localhost:${port}`];
  }
  const m = /^Bearer (\S+)$/.exec(String(h.authorization || ""));
  if (!m || !crypto.timingSafeEqual(digest(m[1]), digest(token))) {
    return [401, "missing or wrong bearer token (SIGNER_TOKEN_FILE)"];
  }
  return null;
}

/** JSON-RPC methods `call` may use: OWN, READS, and `extra` (a predicate). */
function allowed(method, extra = () => false) {
  return OWN.includes(method) || READS.includes(method) || extra(method);
}

/**
 * Serve `handle(call) -> answer` behind every check above on 127.0.0.1;
 * `opts` { port, tokenFile, extra (more methods), log }. Resolves to
 * { server, port, tokenFile } once listening and the token is written.
 */
async function guardedServer(handle, opts) {
  const http = require("http");
  let port = opts.port;
  let token = null;
  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const no = token ? refusal(req, port, token) : [503, "starting"];
    if (no) {
      req.resume();
      return send(res, no[0], {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: no[1] },
      });
    }
    let body = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else body += c;
    });
    req.on("end", async () => {
      let call;
      try {
        call = JSON.parse(body);
      } catch (e) {
        return send(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: e.message },
        });
      }
      // Review L-1: each call is checked and answered on its own; a
      // malformed one, or a handler that throws (an upstream down), is an
      // error answer, never an unhandled rejection that ends the process.
      const bad = (id, message) => ({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32600, message: `Invalid Request: ${message}` },
      });
      const one = async (c) => {
        if (!c || typeof c !== "object" || Array.isArray(c))
          return bad(null, "not a call object");
        if (typeof c.method !== "string") return bad(c.id, "no method");
        if (!allowed(c.method, opts.extra)) {
          return {
            jsonrpc: "2.0",
            id: c.id,
            error: {
              code: -32601,
              message: `${c.method} is not allowed by this signer`,
            },
          };
        }
        try {
          // Round 12 (A1): `reply` answers with its own status and body.
          return await handle(c, req, res, (status, body) =>
            send(res, status, body),
          );
        } catch (e) {
          return {
            jsonrpc: "2.0",
            id: c.id,
            error: { code: -32603, message: e.message },
          };
        }
      };
      let out;
      if (Array.isArray(call)) {
        out = call.length
          ? await Promise.all(call.map(one))
          : bad(null, "an empty batch");
      } else if (call && typeof call === "object") {
        out = await one(call);
      } else {
        out = bad(null, "not a call object");
      }
      if (out !== undefined && !res.writableEnded) send(res, 200, out);
    });
  });
  await new Promise((ok, ko) => {
    server.once("error", ko);
    server.listen(opts.port, "127.0.0.1", ok);
  });
  const addr = server.address();
  if (addr.address !== "127.0.0.1") {
    server.close();
    throw new Error(`bound to ${addr.address}, not 127.0.0.1: refusing`);
  }
  port = addr.port;
  const tokenFile = opts.tokenFile || tokenFileFor(port, process.env, true);
  token = writeToken(tokenFile);
  return { server, port, tokenFile };
}

module.exports = {
  MAX_BODY,
  READS,
  tokenFileFor,
  readToken,
  writeToken,
  refusal,
  allowed,
  guardedServer,
};
