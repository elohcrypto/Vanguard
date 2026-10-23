// Review D-6, round 4 (ported from the swarm's attack-u2r3-allow,
// inverted): off a dev chain the deploy record's hook lets through only
// the methods the deploy flows and ethers call (logged from a deploy
// drive and the test suite), not every eth_, net_ or web3_ name: a raw
// or bundled send, a signature by eth_sign or typed data, a mine or a key
// import never reaches the node, in any letter case. The issuers' claim
// signatures do (vanguard_signClaim, its personal_sign fallback): round 3's
// eth_/net_/web3_ pattern refused them, so the deploy could not sign a
// claim off 31337 (a round-3 regression found in round 4).
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";

const { signClaim } = require("../../demo/utils/Kyc");

const CALLED = [
  "eth_accounts",
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "net_version",
  "personal_sign",
  "vanguard_signClaim",
  "web3_clientVersion",
];
const REFUSED = [
  "eth_sendRawTransactionSync",
  "eth_sendRawTransactionConditional",
  "eth_sendPrivateTransaction",
  "eth_sendPrivateRawTransaction",
  "eth_sendBundle",
  "eth_callBundle",
  "eth_sendTransactionSync",
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_submitWork",
  "eth_submitHashrate",
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_requestAccounts",
  "eth_importRawKey",
  "eth_mine",
  "eth_setCoinbase",
  "net_peerCount",
  "web3_sha3",
  "eth_sendrawtransaction",
  "ETH_sendRawTransaction",
  "eth_Call",
  "eth_getblockbynumber",
  "Net_version",
  "ETH_SIGN",
  "eth_Sign",
  "eth_signtypeddata_v4",
  "eth_SendTransaction",
  "Personal_sign",
  "vanguard_signclaim",
];

describe("D-6 round 4: off a dev chain only the methods the deploy calls reach the node", function () {
  const box = h.files();

  it("a listed method reaches the node; any other is refused before it", async function () {
    const rec = await h.fresh(box.file);
    rec.chainId = 11155111;
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const reached: string[] = [];
    let settling = true; // the record's own reads answered by the node
    p.request = async (a: any) => {
      if (a.method === "eth_chainId") return "0xaa36a7";
      if (settling) return request(a);
      reached.push(a.method);
      return null;
    };
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        p.request({ method: m, params: x ?? [] });
    const r = new Recorder(box.file, rec, 1, () => {});
    const wrong: string[] = [];
    try {
      await r.install();
      settling = false;
      for (const m of REFUSED) {
        const n = reached.length;
        const err = await p.request({ method: m, params: [] }).then(
          () => null,
          (e: Error) => e.message,
        );
        if (!err?.includes(`${m} refused on chain 11155111`))
          wrong.push(`${m}: ${err ?? "returned"}`);
        if (reached.length > n) wrong.push(`${m} reached the node`);
      }
      for (const m of CALLED) {
        await p
          .send(m, [])
          .catch((e: Error) => wrong.push(`${m}: ${e.message}`));
      }
    } finally {
      r.remove();
      p.request = request;
      if (send) p.send = send;
    }
    expect(wrong, "each refused before the node").to.deep.equal([]);
    expect(reached.filter((m) => m !== "eth_chainId")).to.deep.equal(
      CALLED.filter((m) => m !== "eth_chainId"),
    );
  });

  it("an issuer's claim is signed under the record off 31337", async function () {
    const [d, issuer] = await ethers.getSigners();
    const ci = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(issuer.address, "KYC Issuer", "test");
    const rec = await h.fresh(box.file);
    rec.chainId = 11155111;
    const p: any = network.provider;
    const request = p.request.bind(p);
    p.request = (a: any) =>
      a.method === "eth_chainId" ? Promise.resolve("0xaa36a7") : request(a);
    const r = new Recorder(box.file, rec, 1, () => {});
    let sig: string;
    try {
      await r.install();
      sig = await signClaim(d, await ci.getAddress(), h.AGENT, 6, "0x01");
    } finally {
      r.remove();
      p.request = request;
    }
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        [
          "uint256",
          "address",
          "uint256",
          "address",
          "uint256",
          "uint256",
          "bytes",
          "string",
          "uint256",
        ],
        [11155111, await ci.getAddress(), 0, h.AGENT, 6, 1, "0x01", "", 0],
      ),
    );
    expect(ethers.verifyMessage(ethers.getBytes(digest), sig)).to.equal(
      d.address,
    );
  });
});
