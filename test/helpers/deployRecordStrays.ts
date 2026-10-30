import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Recorder } from "../../scripts/production/deployRecord";
import {
  DeployRecord,
  loadRecord,
} from "../../scripts/production/deployRecordFile";
import * as h from "./deployRecordFlow";

/**
 * Review D-2 round 8: the round-7 stray harness (D-2-replace-7,
 * D-2-hidden-7, lane G's attack-u2r7-liveness) shared by the round-8
 * record tests. Call inside a describe: it registers the record files and
 * the hooks (timers shortened to 2 ms, automine restored after each test).
 */
export function strays() {
  const box = h.files();
  const load = (): DeployRecord => loadRecord(box.file)!;
  let realST: any;
  beforeEach(() => {
    realST = global.setTimeout;
    (global as any).setTimeout = (f: any, ms: any, ...a: any[]) =>
      realST(f, Math.min(ms ?? 0, 2), ...a);
  });
  afterEach(async () => {
    (global as any).setTimeout = realST;
    await automine(true);
    await network.provider.request({ method: "evm_mine" });
  });
  const automine = (on: boolean) =>
    network.provider.request({ method: "evm_setAutomine", params: [on] });
  const drop = (hash: string) =>
    network.provider.request({
      method: "hardhat_dropTransaction",
      params: [hash],
    });
  /** A real `ms` wait (the shortened timers aside). */
  const wait = (ms: number) => new Promise((ok) => realST(ok, ms));

  /** A resume whose lines are kept: "accepted", else the refusal. */
  async function resume(lines: string[] = []) {
    const r = new Recorder(box.file, load(), 1, (m) => lines.push(m));
    try {
      await r.install();
      r.remove();
      return "accepted";
    } catch (e: any) {
      return e.message as string;
    }
  }

  /**
   * The round-6 backend: hides `hide` by hash and receipt and answers
   * every count at `start`; its signer drops the nonce field (with `gas`
   * set, so a second re-send is another transaction).
   */
  function liar(start: number, hide: string, gas?: string) {
    return h.node(async (a, request) => {
      if (a.method === "eth_sendTransaction") {
        const { nonce, ...rest } = a.params[0];
        return request({
          method: a.method,
          params: [gas ? { ...rest, gas } : rest],
        });
      }
      if (a.method === "eth_getTransactionCount")
        return ethers.toQuantity(start);
      const hides =
        a.method === "eth_getTransactionByHash" ||
        a.method === "eth_getTransactionReceipt";
      return hides && a.params[0] === hide ? null : undefined;
    });
  }

  /**
   * Entry #0 mined at `start`; a resume behind the liar leaves its
   * re-send at start + 1 pending, recorded as a stray (as GB, cp). With
   * no `gas` the node gives the re-send the block's gas limit, so nothing
   * else fits the pending block beside it.
   */
  async function pendingStray(gas?: string) {
    const start = await h.nonce();
    await h.sendOne(box.file);
    await automine(false);
    const hide = load().txs[0].hash!;
    const restore = liar(start, hide, gas);
    try {
      expect(await h.accepted(box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const stray = load().strays![0].hash;
    expect(await h.accepted(box.file)).to.contain("is pending on this node");
    return { start, stray, hide };
  }

  /** A KeyManager deploy's calldata, the second entry these tests use. */
  const keyManager = async () =>
    (
      await (
        await ethers.getContractFactory("KeyManager")
      ).getDeployTransaction()
    ).data as string;

  return {
    box,
    load,
    automine,
    drop,
    wait,
    resume,
    liar,
    pendingStray,
    keyManager,
  };
}
