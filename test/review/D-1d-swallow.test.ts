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

/** [name, text the verdict must carry, the error]. */
const faults: [string, string, () => any][] = [
  [
    "missing trie node (UNKNOWN_ERROR)",
    "execution reverted: missing trie node",
    () =>
      ethers.makeError("could not coalesce error", "UNKNOWN_ERROR", {
        error: {
          code: -32000,
          message: "execution reverted: missing trie node",
        },
      } as any),
  ],
  [
    "upstream reverted to cache (Error)",
    "upstream reverted to cache",
    () => new Error("503 from reverse proxy: upstream reverted to cache"),
  ],
  ["timeout", "ETIMEDOUT", () => new Error("request timeout (ETIMEDOUT)")],
  [
    "429",
    "Too Many Requests",
    () =>
      ethers.makeError("Too Many Requests", "SERVER_ERROR", {
        request: {} as any,
        response: { statusCode: 429 } as any,
      }),
  ],
];

/** "No such function" as ethers (public RPC) and a Hardhat node report it. */
const missing: [string, () => any][] = [
  [
    "CALL_EXCEPTION without data",
    () =>
      ethers.makeError("missing revert data", "CALL_EXCEPTION", {
        action: "call",
        data: null,
        reason: null,
        transaction: {} as any,
        invocation: null,
        revert: null,
      } as any),
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

/** `fn` with every eth_call of selector `sel` to `to` throwing `mk()`. */
async function faulted(to: string, sel: string, mk: () => any, fn: () => any) {
  const prov: any = ethers.provider;
  const call = prov.call.bind(prov);
  let hits = 0;
  prov.call = async (tx: any) => {
    const at = String(tx.to).toLowerCase() === to.toLowerCase();
    if (at && String(tx.data).startsWith(sel)) {
      hits++;
      throw mk();
    }
    return call(tx);
  };
  try {
    const r = await Promise.resolve()
      .then(fn)
      .then(
        (v) => ({ v, err: "" }),
        (e: any) => ({ v: undefined, err: String(e.message) }),
      );
    return { ...r, hits };
  } finally {
    prov.call = call;
  }
}

const sel = (sig: string) => ethers.id(sig).slice(0, 10);
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
  },
  {
    name: "a trusted contract's factory()",
    at: async (f) => f.govAddr,
    sig: "factory()",
    read: (f) => escrowFactoriesFromChain(f.args),
    absent: (r) => expect(r).to.deep.equal({ v: [], err: "" }),
    audit: true,
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
