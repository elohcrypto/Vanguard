"use strict";
/**
 * The production signer's upstream connection (scripts/production/
 * signer.js), split out by the 500-line rule (U2 round 15).
 *
 * Round 14 (A, R14-C1): one upstream attempt per send. ethers re-sent the
 * same raw transaction on an HTTP 429 (its throttle retry), so a forward
 * answered 429 reached the node twice; and it follows a redirect with a
 * fresh request (fetch.js redirect()), so a response's location header is
 * dropped: a 3xx is the answer.
 * Round 15 (C, R15-C3, lane G G14-3): the retry is decided per request.
 * eth_sendRawTransaction is never retried (a 429 after it is a transport
 * failure, HTTP 502); every read keeps ethers' 429 retry, as before round
 * 14, so a rate-limited read of the signer's own (the code it shows, the
 * fee block, the gas estimate) no longer fails the send step. No request
 * is added on a clean path: ethers asks retryFunc only after a 429.
 */
const { FetchRequest, JsonRpcProvider, toUtf8String } = require("ethers");

/** True when `req`'s JSON-RPC body (one call or a batch) sends a raw transaction; an unreadable body counts as one. */
function sends(req) {
  try {
    return [].concat(JSON.parse(toUtf8String(req.body))).some((c) => c?.method === "eth_sendRawTransaction");
  } catch {
    return true;
  }
}

/** A provider on the URL `upstream`: a read retried on a 429, a send never, no redirect followed. */
function upstreamProvider(upstream) {
  const conn = new FetchRequest(upstream);
  conn.retryFunc = async (req) => !sends(req);
  const get = conn.getUrlFunc;
  conn.getUrlFunc = async (req, signal) => {
    const r = await get(req, signal);
    delete r.headers.location;
    return r;
  };
  return new JsonRpcProvider(conn, undefined, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
}

module.exports = { upstreamProvider };
