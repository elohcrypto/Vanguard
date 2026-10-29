// U2 round 15 (item C, lane G G14-3, lane C row 429code; R15-C3): round
// 14's `retryFunc = async () => false` made one upstream attempt per
// request, the signer's OWN reads included (the code it shows, the fee
// block, the gas estimate). A 429 on such a read came back to the CLI as
// a coded -32000 over HTTP 200, so RpcRetry re-ran the whole send step,
// and under an every-4th-request 429 each attempt met another 429 (lane
// G: 49/72 sends after 22 resumes). Now the retry is decided per request:
// eth_sendRawTransaction never (one attempt, R14-C1), every read keeps
// ethers' throttle retry. And a send the record re-sent that a rate limit
// answered is refused as a rate limit, not as a lagging RPC.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { Live, rpc, runSigner } from "../helpers/signerProcess";
import {
  EntryChain,
  RecordRefusal,
} from "../../scripts/production/deployRecordChain";
import * as h from "../helpers/deployRecordFlow";

describe("U2 round 15: reads retry, the send never", function () {
  this.timeout(300000);
  const PASS = "a long enough test password";
  let dir: string;
  let base: (a: any) => Promise<any>;

  before(() => (base = network.provider.request.bind(network.provider)));
  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "signer-transport-15-"));
    fs.mkdirSync(path.join(dir, "keys"), { mode: 0o700 });
    const w = ethers.Wallet.fromPhrase(
      "test test test test test test test test test test test junk",
    );
    fs.writeFileSync(
      path.join(dir, "keys", "a.json"),
      await ethers.encryptKeystoreJson(
        { address: w.address, privateKey: w.privateKey },
        PASS,
        { scrypt: { N: 1 << 10 } },
      ),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * The in-process node behind a proxy: `read429:<method>` answers the
   * first such read HTTP 429 unforwarded; `readN:<n>` every n-th read
   * (lane G's proxy14.js shapes), once `armed`. `sendsIn` counts the raw transactions
   * the node received; `faults` the 429s answered.
   */
  async function proxy(mode: string) {
    const st = { sendsIn: 0, faults: 0, reads: 0, armed: false };
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        const c = JSON.parse(b);
        const raw = c.method === "eth_sendRawTransaction";
        const once = st.armed && mode === `read429:${c.method}` && st.faults === 0;
        const nth = st.armed && !raw && /readN:/.test(mode) && ++st.reads % Number(/readN:(\d+)/.exec(mode)![1]) === 0;
        if (once || nth) {
          st.faults++;
          res.statusCode = 429;
          res.setHeader("content-type", "text/plain");
          return res.end("Too Many Requests");
        }
        let out: any;
        try {
          if (raw) st.sendsIn++;
          out = { jsonrpc: "2.0", id: c.id, result: await base(c) };
        } catch (e: any) {
          out = { jsonrpc: "2.0", id: c.id, error: { code: e.code ?? -32603, message: e.message } };
        }
        if (raw && st.armed && mode.startsWith("send429+")) {
          st.faults++;
          res.statusCode = 429;
          res.setHeader("content-type", "text/plain");
          return res.end("Too Many Requests");
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { server, st, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const env = (url: string) => ({
    SIGNER_UPSTREAM: url,
    SIGNER_TEST: "1",
    SIGNER_PROMPT: "0",
    SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
    SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
    SIGNER_TOKEN_FILE: path.join(dir, "token"),
  });
  const nonce = async () =>
    ethers.provider.getTransactionCount((await ethers.getSigners())[0].address);

  /** One eth_sendTransaction through the real signer behind `mode`, armed once the signer is up (its startup reads pass). */
  async function send(mode: string) {
    const [d] = await ethers.getSigners();
    const up = await proxy(mode);
    const start = await nonce();
    let a: any;
    try {
      await runSigner("scripts/production/signer.js", env(up.url), async (live: Live) => {
        up.st.armed = true;
        a = await rpc(live, "eth_sendTransaction", [
          { from: d.address, to: d.address, value: "0x1", nonce: ethers.toQuantity(start) },
        ]);
      });
    } finally {
      up.server.close();
    }
    return { a, sendsIn: up.st.sendsIn, faults: up.st.faults, start, end: await nonce() };
  }

  // eth_getCode is SignerTransport-14's 429code row (its expectation
  // flipped by R15-C3, countersigned R15-CS3); these are the other reads.
  for (const m of ["eth_getBlockByNumber", "eth_estimateGas"])
    it(`a 429 once on the signer's own ${m} is retried: the hash, one raw at the node`, async function () {
      const r = await send(`read429:${m}`);
      expect(r.faults, "the 429 was answered").to.equal(1);
      expect(r.a.status, JSON.stringify(r.a.body)).to.equal(200);
      expect(r.a.body.error, "no relayed refusal").to.equal(undefined);
      expect(r.a.body.result).to.match(/^0x[0-9a-f]{64}$/);
      expect(r.sendsIn, "raw transactions the node received").to.equal(1);
      expect(r.end).to.equal(r.start + 1);
    });

  it("every 2nd read answered 429 (lane G's readN shape): the send still answers its hash", async function () {
    const r = await send("readN:2");
    expect(r.faults, "429s answered").to.be.above(0);
    expect(r.a.body.result, JSON.stringify(r.a.body)).to.match(/^0x[0-9a-f]{64}$/);
    expect(r.sendsIn).to.equal(1);
    expect(r.end).to.equal(r.start + 1);
  });

  it("Z14-01..04's guard: a send forwarded, then answered 429, still gets one attempt while reads are retried: 502, one raw at the node", async function () {
    const r = await send("send429+readN:2");
    expect(r.a.status, JSON.stringify(r.a.body)).to.equal(502);
    expect(r.a.body.transport).to.match(/^HTTP 502: .*429/);
    expect(r.sendsIn, "raw transactions the node received").to.equal(1);
    expect(r.end, "the one copy mined").to.equal(r.start + 1);
  });

  describe("the record's refusal after a re-send answered by a rate limit", function () {
    const H = "0x" + "ab".repeat(32);
    const entry = (): any => ({
      from: "0x00000000000000000000000000000000000000aa",
      to: null,
      value: "0",
      dataHash: ethers.keccak256("0x6001"),
      data: "0x6001",
      nonce: 5,
      block: 100,
      status: "sent",
      hash: H,
      label: "x",
    });
    let real: typeof setTimeout;
    beforeEach(() => {
      real = global.setTimeout;
      (global as any).setTimeout = (f: any) => real(f, 0);
    });
    afterEach(() => {
      (global as any).setTimeout = real;
    });
    /** The entry unknown, its nonce free, and its re-send failing with `msg` (no code: a transport failure). */
    const refusal = async (msg: string) => {
      const e = entry();
      const raw = async (m: string) => {
        if (m === "eth_getTransactionCount") return "0x5";
        if (m === "eth_blockNumber") return "0x70";
        if (m === "eth_sendTransaction") throw new Error(msg);
        return null;
      };
      const out = await new EntryChain(h.fused(raw), { chainId: 11155111, txs: [e] } as any, 1, () => {}, () => {})
        .receipt(e)
        .then((x) => x, (x) => x);
      expect(out).to.be.instanceOf(RecordRefusal);
      return { out, e };
    };

    it("a 429 is named: the RPC rate-limited the send; kept in the record, wait, then resume", async function () {
      const { out, e } = await refusal('HH110: Invalid JSON-RPC response received: {"transport":"HTTP 502: server response 429 Too Many Requests"}');
      expect(out.message).to.contain("server response 429 Too Many Requests");
      expect(out.message).to.match(/: the RPC rate-limited the send; kept in the record, wait, then resume$/);
      expect(out.message).not.to.contain("lagging");
      expect(e.resendFrom, "the intent is kept").to.equal(0x70);
    });

    it("control: another transport failure keeps the lagging-RPC text", async function () {
      const { out } = await refusal("HH110: Invalid JSON-RPC response received: <html>502 Bad Gateway</html>");
      expect(out.message).to.match(/: a lagging or inconsistent RPC; kept in the record, resume against a synced RPC$/);
    });
  });
});
