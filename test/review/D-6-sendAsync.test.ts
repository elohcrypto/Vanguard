// Review D-6, round 2 (ported from the swarm's attack-u2-d6, inverted):
// the deploy record's hook covers every entry point of the provider. Off
// a dev chain an evm_, hardhat_ or anvil_ call is refused before it
// reaches the node, through sendAsync as through request and send, and so
// is a raw transaction.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import * as h from "../helpers/deployRecordFlow";

describe("D-6 every provider entry point goes through the record", function () {
  const box = h.files();

  it("sendAsync and anvil_ calls off the dev chain are refused, nothing reaches the node", async function () {
    const p: any = network.provider;
    const request = p.request.bind(p);
    const rec = await h.fresh(box.file);
    const r = new Recorder(box.file, rec, 1, () => {});
    await r.install();
    rec.chainId = 11155111; // the same Recorder, for a Sepolia deploy
    const head = async () =>
      Number(await request({ method: "eth_blockNumber" }));
    const balance = async () =>
      BigInt(
        await request({
          method: "eth_getBalance",
          params: [h.AGENT, "latest"],
        }),
      );
    const viaAsync = (method: string, params: unknown[]) =>
      new Promise<any>((ok) =>
        p.sendAsync(
          { jsonrpc: "2.0", id: 1, method, params },
          (e: any, v: any) => ok(e ?? v?.error ?? v),
        ),
      );
    try {
      const [h0, b0] = [await head(), await balance()];
      const mined = await viaAsync("evm_mine", []);
      expect(String(mined?.message)).to.match(
        /evm_mine refused on chain 11155111: no dev-node call off a dev chain/,
      );
      const set = await viaAsync("hardhat_setBalance", [h.AGENT, "0x1234"]);
      expect(String(set?.message)).to.match(
        /hardhat_setBalance refused on chain 11155111/,
      );
      const raw = await viaAsync("eth_sendRawTransaction", ["0x00"]);
      expect(String(raw?.message)).to.match(
        /the deploy sends only through its record and the external signer \(eth_sendRawTransaction refused\)/,
      );
      const anvil = await p
        .request({ method: "anvil_setBalance", params: [h.AGENT, "0x5678"] })
        .catch((e: any) => e);
      expect(String(anvil?.message)).to.match(
        /anvil_setBalance refused on chain 11155111/,
      );
      expect([await head(), await balance()]).to.deep.equal([h0, b0]);
      // a plain read still answers through sendAsync
      const chain = await viaAsync("eth_chainId", []);
      expect(Number(chain.result)).to.equal(
        Number((await ethers.provider.getNetwork()).chainId),
      );
    } finally {
      r.remove();
    }
    expect(typeof p.sendAsync).to.equal("function");
  });
});
