// D-1d (round 4, F3 LOW-4): six reads outside the Safe reader took any
// error whose text says "revert" for "no such function": an oracle's
// listManager(), VGT's whitelistMode, a trusted contract's investor()
// and factory(), ComplianceRules.privacyManager(token) and
// PrivacyManager.policyToken(). An RPC fault whose text says "reverted"
// skipped a check, or blamed the contract ("predates Task 3.4/3.8").
// Only noSuchFunction reads as absent now: each fault fails the read,
// the preflight and the audit with its own text, before the deployer
// sends anything; a missing selector keeps the reading it had.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";
import { faults, faulted, rpcError } from "./D-1c-common";

const {
  listManagerOf,
  vgtWhitelistMode,
} = require("../../demo/utils/HandoverChecks");
const { escrowFactoriesFromChain } = require("../../demo/utils/HandoverScans");
const { preflightEscrow } = require("../../demo/utils/HandoverEscrow");
const {
  wiredPrivacy,
  preflightPrivacy,
} = require("../../demo/utils/HandoverPrivacy");

/** "No such function" as ethers' JsonRpcProvider and a Hardhat node report it. */
const missing: [string, (tx: any) => any][] = [
  [
    "an empty revert through ethers' JsonRpcProvider (data 0x)",
    (tx) =>
      rpcError({ code: 3, message: "execution reverted", data: "0x" }, tx),
  ],
  [
    "a Hardhat node's -32603 with data 0x",
    () =>
      Object.assign(
        new Error(
          "Transaction reverted: function selector was not recognized and there's no fallback function",
        ),
        { code: -32603, data: { message: "reverted", data: "0x" } },
      ),
  ],
];

const sel = (sig: string) => ethers.id(sig).slice(0, 10);

/** The error a call that reverts with a reason throws (MockTarget's). */
async function revertWithReason() {
  const s19 = (await ethers.getSigners())[19];
  const x: any = await (
    await ethers.getContractFactory("MockTarget", s19)
  ).deploy();
  const data = x.interface.encodeFunctionData("revertFunction");
  const to = await x.getAddress();
  const e = await ethers.provider.call({ to, data }).then(
    () => null,
    (e: any) => e,
  );
  expect(e, "revertFunction() reverts").to.not.equal(null);
  return e;
}

const addr = (c: any) => c.getAddress();

/**
 * Each read: where it goes, the call that makes it, what a missing
 * selector reads as (`absent`: the call's value, or the refusal's
 * words), and whether the audit reads it too.
 */
const sites: {
  name: string;
  at: (f: any) => Promise<string>;
  sig: string;
  read: (f: any) => Promise<any>;
  absent: (r: { v: any; err: string }) => void;
  audit: boolean;
  reason?: boolean;
}[] = [
  {
    name: "an oracle's listManager()",
    at: (f) => addr(f.args.oracles[0]),
    sig: "listManager()",
    read: (f) => listManagerOf(f.args.oracles[0]),
    absent: (r) => expect(r).to.deep.equal({ v: null, err: "" }),
    audit: true,
  },
  {
    name: "VGT's whitelistMode",
    at: (f) => addr(f.c.complianceRules),
    sig: "whitelistMode(address)",
    read: (f) => vgtWhitelistMode(f.args),
    absent: (r) => expect(r).to.deep.equal({ v: null, err: "" }),
    audit: true,
  },
  {
    name: "a trusted contract's investor()",
    at: async (f) => f.govAddr,
    sig: "investor()",
    read: (f) => preflightEscrow(f.args),
    absent: (r) => expect(r.err).to.equal(""),
    audit: true,
    reason: true,
  },
  {
    name: "a trusted contract's factory()",
    at: async (f) => f.govAddr,
    sig: "factory()",
    read: (f) => escrowFactoriesFromChain(f.args),
    absent: (r) => expect(r).to.deep.equal({ v: [], err: "" }),
    audit: true,
    reason: true,
  },
  {
    name: "ComplianceRules.privacyManager(token)",
    at: (f) => addr(f.c.complianceRules),
    sig: "privacyManager(address)",
    read: (f) => wiredPrivacy(f.args, undefined),
    absent: (r) => expect(r.err).to.contain("(predates Task 3.4)"),
    audit: true,
  },
  {
    name: "PrivacyManager.policyToken()",
    at: (f) => addr(f.c.privacyManager),
    sig: "policyToken()",
    read: (f) => preflightPrivacy(f.args),
    absent: (r) => expect(r.err).to.contain("(predates Task 3.8)"),
    audit: false,
  },
];

describe("D-1d errors at the six reads outside the Safe reader", function () {
  this.timeout(900000);
  for (const s of sites) {
    it(`${s.name}: a fault fails the read with its text; no such function keeps its reading`, async function () {
      const f = await handoverFixture();
      const to = await s.at(f);
      for (const [kn, text, mk] of faults) {
        const r = await faulted(to, sel(s.sig), mk, () => s.read(f));
        console.log(`      [${kn}] hits=${r.hits}: ${r.err || "no error"}`);
        expect(r.hits, kn).to.be.greaterThan(0);
        expect(r.err, kn).to.contain(text);
      }
      for (const [kn, mk] of missing) {
        const r = await faulted(to, sel(s.sig), mk, () => s.read(f));
        console.log(`      [${kn}] hits=${r.hits}: ${r.err || r.v}`);
        expect(r.hits, kn).to.be.greaterThan(0);
        s.absent({ v: r.v, err: r.err });
      }
    });

    it(`${s.name}: a fault fails the preflight${s.audit ? " and the audit" : ""} with its text, nothing sent`, async function () {
      const f = await handoverFixture();
      const d = f.deployer.address;
      const to = await s.at(f);
      const { cfg, cfgPath, dir } = await cliConfig(f);
      const run = (p: string) => h.phase(cfg, p, cfgPath);
      const reverted = s.reason ? await revertWithReason() : undefined;
      const n = await ethers.provider.getTransactionCount(d);
      for (const [kn, text, mk] of faults) {
        const r = await faulted(to, sel(s.sig), mk, () => run("preflight"));
        const v = r.v.verdict;
        console.log(
          `      preflight [${kn}] hits=${r.hits}: ${v.slice(0, 120)}`,
        );
        expect(r.hits, kn).to.be.greaterThan(0);
        expect(v, kn).to.contain(text);
      }
      if (s.reason) {
        // Round 4 (F4 LOW-1), fail-closed by design: a trusted contract
        // whose read reverts with a reason blocks the ceremony with it.
        const r = await faulted(
          to,
          sel(s.sig),
          () => reverted,
          () => run("preflight"),
        );
        console.log(`      preflight [a revert with a reason]: ${r.v.verdict}`);
        expect(r.hits).to.be.greaterThan(0);
        expect(r.v.verdict).to.contain("MockTarget: Intentional revert");
      }
      expect(await ethers.provider.getTransactionCount(d)).to.equal(n);
      expect((await run("full")).verdict).to.equal("ok");
      if (s.audit) {
        for (const [kn, text, mk] of faults) {
          const r = await faulted(to, sel(s.sig), mk, () => run("audit"));
          const v = r.v.verdict;
          console.log(`      audit [${kn}] hits=${r.hits}: ${v.slice(0, 120)}`);
          expect(r.hits, kn).to.be.greaterThan(0);
          expect(v, kn).to.contain(text);
        }
        expect((await run("audit")).verdict).to.equal("ok");
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
});
