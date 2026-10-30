// Review D-6 (ported from the reviewer's P-D-6.test.ts, inverted): an
// evm_ or hardhat_ call off the dev chain is refused with a plain error
// the caller can catch, and the deploy goes on; the default production
// deploy path makes no such call.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  deployStack,
  rolePause,
} from "../../scripts/production/DeployProduction";
import { resolveInputs } from "../../scripts/production/deployConfig";
import { configureKeyManager } from "../../scripts/production/opsKeyManager";
import * as h from "../helpers/deployRecordFlow";

const {
  attestorPublicKey,
  newAttestorKey,
} = require("../../scripts/zk/attest");
const quiet = () => {};

describe("D-6 dev-node calls off the dev chain", function () {
  this.timeout(900000);
  const box = h.files();

  it("a caught evm_ refusal off the dev chain does not stop the deploy", async function () {
    // A fresh ChainTime (it caches its first answer), dropped again after
    // so no later file gets this one's "cannot jump".
    const path = require.resolve("../../demo/utils/ChainTime");
    delete require.cache[path];
    const ChainTime = require(path);
    const rec = await h.fresh(box.file);
    const r = new Recorder(box.file, rec, 1, quiet);
    await r.install();
    try {
      rec.chainId = 11155111; // the same Recorder, for a Sepolia deploy
      expect(await ChainTime.canJumpTime()).to.equal(false);
      const err: any = await ethers.provider
        .send("evm_mine", [])
        .catch((e: any) => e);
      expect(String(err?.message)).to.match(
        /evm_mine refused on chain 11155111: no dev-node call off a dev chain/,
      );
      expect(err.name).to.not.equal("RecordRefusal");
      const [d] = await ethers.getSigners();
      // Bounded: a send whose transaction the node is never asked for
      // (ethers polls it) fails here, not by the run's timeout.
      let t: any;
      const shown = new Promise<never>((_, ko) => {
        t = setTimeout(
          () => ko(new Error("the send was not shown in 20 s")),
          2e4,
        );
      });
      const rc = await Promise.race([
        d.sendTransaction({ to: d.address, value: 1n }).then((x) => x.wait()),
        shown,
      ]).finally(() => clearTimeout(t));
      expect(rc!.status).to.equal(1);
    } finally {
      r.remove();
      delete require.cache[path];
    }
  });

  it("the default production deploy path (deployStack + configureKeyManager) makes no evm_/hardhat_ call", async function () {
    // Installed before the Recorder: it sees what the Recorder passes on.
    const p: any = network.provider;
    const request = p.request.bind(p);
    const seen: string[] = [];
    p.request = (a: any) => {
      if (/^(evm_|hardhat_)/.test(a.method)) seen.push(a.method);
      return request(a);
    };
    const send = typeof p.send === "function" ? p.send.bind(p) : null;
    if (send)
      p.send = (m: string, a?: unknown[]) => (
        /^(evm_|hardhat_)/.test(m) && seen.push(m),
        send(m, a)
      );
    try {
      const accounts = (await ethers.getSigners()).map((s) => s.address);
      const { Ax, Ay } = await attestorPublicKey(newAttestorKey());
      const inputs = resolveInputs(
        { attestor: { Ax: Ax.toString(), Ay: Ay.toString() } } as any,
        31337,
        accounts,
      );
      const rec = await h.fresh(box.file);
      const recorder = new Recorder(box.file, rec, 1, quiet);
      await recorder.install();
      const roles = rolePause(inputs, box.file, recorder);
      recorder.refuseFrom(
        Object.fromEntries(inputs.external.map((k) => [k, (inputs as any)[k]])),
      );
      const log = console.log;
      console.log = () => {};
      try {
        const state = await deployStack(inputs, rec.salt, roles);
        await configureKeyManager(
          state.getContract("keyManager"),
          { address: inputs.deployer },
          undefined,
          {},
          roles,
        );
        await recorder.finish();
      } finally {
        console.log = log;
        recorder.remove();
      }
      expect(recorder.sent).to.be.greaterThan(50);
      expect(seen).to.deep.equal([]);
      await ethers.provider.send("evm_mine", []);
      expect(seen).to.deep.equal(["evm_mine"]); // the counter sees one made the same way
    } finally {
      p.request = request;
      if (send) p.send = send;
    }
  });
});
