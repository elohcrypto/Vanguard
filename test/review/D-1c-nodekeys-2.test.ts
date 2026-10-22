// D-1c (round 4, F3 LOW-1/LOW-2): A7's tests pinned two of roleOf's
// eight reads. Each read now: a fault on it (a missing trie node, a
// proxy's "reverted to cache", a timeout, a 429) makes roleOf reject
// with that error, and fails the preflight, the full phase and the
// audit with it before the deployer sends anything. noSuchFunction's
// CALL_EXCEPTION branch, which hardhat-ethers never emits, is pinned on
// synthetic errors: round 5, only data "0x" is no such function.
import { expect } from "chai";
import * as fs from "fs";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { cliConfig } from "../helpers/handoverCli";
import * as h from "./D-1b-common";
import { faults, faulted } from "./D-1c-common";

const { roleOf } = require("../../demo/utils/HandoverNodeKeys");
const { noSuchFunction } = require("../../demo/utils/RoleSafe");

/** roleOf's reads: [name, the contract, function, args for `node`]. */
const reads = (f: any, node: string): [string, any, string, any[]][] => [
  ["OracleManager operator()", f.c.oracleManager, "operator", []],
  ["VSC isAgent", f.c.token, "isAgent", [node]],
  ["IdentityRegistry isAgent", f.c.identityRegistry, "isAgent", [node]],
  ["VGT isAgent", f.c.governanceToken, "isAgent", [node]],
  ["ITR isGovernor", f.c.investorTypeRegistry, "isGovernor", [node]],
  [
    "ITR isComplianceOfficer",
    f.c.investorTypeRegistry,
    "isComplianceOfficer",
    [node],
  ],
  ["ClaimIssuer owner()", f.kycIssuer, "owner", []],
  ["ClaimIssuer getKeysByPurpose", f.kycIssuer, "getKeysByPurpose", [1]],
];

/**
 * Where roleOf's call of `fn` goes and its exact calldata, so a phase's
 * other reads of `fn` (for another account) stay unfaulted.
 */
const target = async (c: any, fn: string, args: any[]) => ({
  to: (await c.getAddress()) as string,
  sel: c.interface.encodeFunctionData(fn, args),
});

describe("D-1c roleOf: every read fails on a fault", function () {
  this.timeout(1800000);
  it("roleOf rejects with the fault's text at each of its eight reads", async function () {
    const f = await handoverFixture();
    const node = ethers.Wallet.createRandom().address;
    const o = {
      oracleManager: f.c.oracleManager,
      token: f.c.token,
      identityRegistry: f.c.identityRegistry,
      governanceToken: f.c.governanceToken,
      investorTypeRegistry: f.c.investorTypeRegistry,
      issuers: [f.kycIssuer],
    };
    expect(await roleOf(o, node)).to.equal(null);
    for (const [name, c, fn, args] of reads(f, node)) {
      const { to, sel } = await target(c, fn, args);
      for (const [kn, text, mk] of faults) {
        const r = await faulted(to, sel, mk, () => roleOf(o, node));
        expect(r.hits, `${name} / ${kn}`).to.be.greaterThan(0);
        expect(r.err, `${name} / ${kn}`).to.contain(text);
      }
    }
  });

  it("each fault fails the preflight, the full phase and the audit; nothing sent", async function () {
    const f = await handoverFixture();
    const d = f.deployer.address;
    const s = await ethers.getSigners();
    const nodes = [s[12], s[13], s[14]].map((x) => x.address);
    for (const [i, a] of nodes.entries())
      await (
        await f.c.oracleManager.registerOracle(a, `N${i}`, "", 500)
      ).wait();
    const { cfg, cfgPath, dir } = await cliConfig(f);
    cfg.oracleNodes = nodes;
    const run = async (p: string) => (await h.phase(cfg, p, cfgPath)).verdict;
    const n = await ethers.provider.getTransactionCount(d);
    for (const [name, c, fn, args] of reads(f, nodes[0])) {
      const { to, sel } = await target(c, fn, args);
      for (const [kn, text, mk] of faults) {
        for (const p of ["preflight", "full"]) {
          const r = await faulted(to, sel, mk, () => run(p));
          const why = `${p}: ${name} / ${kn}`;
          console.log(`      ${why} hits=${r.hits}: ${r.v.slice(0, 90)}`);
          expect(r.hits, why).to.be.greaterThan(0);
          expect(r.v, why).to.contain(text);
        }
      }
    }
    expect(await ethers.provider.getTransactionCount(d)).to.equal(n);
    expect(await run("full")).to.equal("ok");
    for (const [name, c, fn, args] of reads(f, nodes[0])) {
      const { to, sel } = await target(c, fn, args);
      for (const [kn, text, mk] of faults) {
        const r = await faulted(to, sel, mk, () => run("audit"));
        const why = `audit: ${name} / ${kn}`;
        expect(r.hits, why).to.be.greaterThan(0);
        expect(r.v, why).to.contain(text);
      }
    }
    expect(await run("audit")).to.equal("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("D-1c noSuchFunction on ethers' CALL_EXCEPTION", function () {
  const callException = (data: any) =>
    ethers.makeError("missing revert data", "CALL_EXCEPTION", {
      action: "call",
      data,
      reason: null,
      transaction: {} as any,
      invocation: null,
      revert: null,
    } as any);
  it("only data 0x is no such function; no data or revert data is not", function () {
    const reason = ethers.concat([
      "0x08c379a0",
      ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["nope"]),
    ]);
    expect(noSuchFunction(callException(null))).to.equal(false);
    expect(noSuchFunction(callException(undefined))).to.equal(false);
    expect(noSuchFunction(callException("0x"))).to.equal(true);
    expect(noSuchFunction(callException(reason))).to.equal(false);
  });
});
