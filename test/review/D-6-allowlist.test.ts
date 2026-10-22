// Review D-6, round 3 (ported from the swarm's attack-u2r2-dev, inverted):
// off a dev chain the deploy record's hook lets only eth_, net_ and web3_
// methods reach the node (eth_sendUnsignedTransaction refused too), and a
// method that is not a string is refused on any chain, through request,
// send, sendAsync and the ethers provider.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";

describe("D-6 off a dev chain only eth_, net_ and web3_ calls reach the node", function () {
  const box = h.files();

  it("every other method or shape is refused before the node; reads still answer", async function () {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const send = p.send?.bind(p);
    const reached: string[] = [];
    p.request = async (a: any) => {
      if (a.method === "eth_chainId") return "0xaa36a7";
      if (
        typeof a.method !== "string" ||
        !/^(eth_|net_|web3_)/.test(a.method) ||
        a.method === "eth_sendUnsignedTransaction"
      ) {
        reached.push(JSON.stringify(a.method) ?? String(a.method));
        return null;
      }
      return request(a);
    };
    if (send)
      p.send = (m: string, x?: unknown[]) =>
        p.request({ method: m, params: x ?? [] });
    const rec = await h.fresh(box.file);
    rec.chainId = 11155111;
    const r = new Recorder(box.file, rec, 1, () => {});
    await r.install();
    const out: string[] = [];
    const refused = async (name: string, f: () => Promise<any>) => {
      const n = reached.length;
      const err = await f().then(
        (v) => (v && v.error ? v.error : null),
        (e) => e,
      );
      if (!err || reached.length > n)
        out.push(
          `${name}: ${err ? "threw" : "returned"}, reached ${reached.slice(n).join(",") || "no"}`,
        );
    };
    const viaAsync = (q: any) =>
      new Promise<any>((ok, ko) =>
        p.sendAsync(q, (e: any, v: any) => (e ? ko(e) : ok(v))),
      );
    try {
      for (const m of [
        "debug_setHead",
        "miner_start",
        "miner_setEtherbase",
        "tenderly_setBalance",
        "ganache_setAccountBalance",
        "personal_sendTransaction",
        "personal_unlockAccount",
        "admin_addPeer",
        "eth_sendUnsignedTransaction",
        "txpool_flush",
        "engine_forkchoiceUpdatedV3",
        "hardhat_metadata",
        "EVM_mine",
        " evm_mine",
        "evm_mine",
      ]) {
        await refused(`request ${JSON.stringify(m)}`, () =>
          p.request({ method: m, params: [] }),
        );
        await refused(`send ${JSON.stringify(m)}`, () => p.send(m, []));
        await refused(`sendAsync ${JSON.stringify(m)}`, () =>
          viaAsync({ jsonrpc: "2.0", id: 1, method: m, params: [] }),
        );
      }
      await refused("a method object (toJSON -> evm_mine)", () =>
        p.request({ method: { toJSON: () => "evm_mine" }, params: [] }),
      );
      let k = 0;
      await refused(
        "a method object (toString eth_chainId, then evm_mine)",
        () =>
          p.request({
            method: {
              toString: () => (k++ === 0 ? "eth_chainId" : "evm_mine"),
            },
            params: [],
          }),
      );
      await refused("send with a batch array", () =>
        p.send([{ method: "evm_mine", params: [], id: 1, jsonrpc: "2.0" }]),
      );
      await refused("sendAsync with a batch array", () =>
        viaAsync([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "hardhat_setBalance",
            params: [h.AGENT, "0x1"],
          },
        ]),
      );
      await refused("sendAsync without a method", () =>
        viaAsync({ jsonrpc: "2.0", id: 1 }),
      );
      await refused("ethers.provider.send debug_setHead", () =>
        (ethers.provider as any).send("debug_setHead", ["0x1"]),
      );
      expect(Number(await p.request({ method: "eth_chainId" }))).to.equal(
        11155111,
      );
      expect(await p.send("eth_blockNumber", [])).to.match(/^0x[0-9a-f]+$/);
      expect(await p.request({ method: "net_version" })).to.be.a("string");
      expect(await p.request({ method: "web3_clientVersion" })).to.be.a(
        "string",
      );
    } finally {
      r.remove();
      p.request = request;
      if (send) p.send = send;
    }
    expect(out, "each refused, none reached the node").to.deep.equal([]);
    expect(reached).to.deep.equal([]);
  });
});
