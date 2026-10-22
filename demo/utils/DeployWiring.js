/**
 * @fileoverview The deploy flows' wiring, read back from chain (review F-3)
 * @module DeployWiring
 * @description Options 74, 51 and 61 wire each contract they deploy
 * (agents, rule administrators, trust, the registry links and the token's
 * authorization, the registrars, the compliance officers, the custody
 * lock amounts, the escrow fee wallet's identity and exemption). Option
 * 1a, option 74 (its own links) and the production deploy report success
 * only when every link below reads true on chain: a contract in demo
 * state proves it was deployed, not that it was wired. A check runs only
 * once its contracts are in state, so it holds before and after the
 * handover.
 */

"use strict";

const { ethers } = require("hardhat");
const { walletCodeHash } = require("./GovernedCalls");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Each check for `state`'s contracts: [{ name, ok }], in deploy order;
 * with `flow` ("51", "74" or "61"), only the links that option makes.
 */
async function wiring(state, flow) {
  const c = (k) => state.getContract(k);
  const [rules, vsc, ir] = [
    c("complianceRules"),
    c("digitalToken"),
    c("identityRegistry"),
  ];
  const [types, irm, vgt, gov, escrow] = [
    c("investorTypeRegistry"),
    c("investorRequestManager"),
    c("governanceToken"),
    c("vanguardGovernance"),
    c("escrowFactory"),
  ];
  const deployer = state.signers[0].address;
  const checks = [];
  const add = (by, name, read) => checks.push([by, name, read]);
  if (types && vsc) {
    add("51", "VSC investor type registry", async () =>
      same(await vsc.investorTypeRegistry(), await types.getAddress()),
    );
    add("51", "VSC authorized on InvestorTypeRegistry", () =>
      types.isTokenAuthorized(vsc),
    );
    add("51", "InvestorRequestManager (custody) registrar on VSC", async () =>
      irm
        ? (await rules.trustedRegistrars(vsc, irm)) ===
          (await walletCodeHash("MultiSigWallet"))
        : false,
    );
    add("51", "InvestorRequestManager compliance officer", async () =>
      irm ? types.isComplianceOfficer(irm) : false,
    );
    const locks = state.production?.lockRequirements;
    if (locks) {
      add("51", "custody lock requirements as configured", async () => {
        if (!irm) return false;
        for (const [i, t] of [1, 2, 3].entries()) {
          if ((await irm.lockRequirements(t)) !== BigInt(locks[i]))
            return false;
        }
        return true;
      });
    }
  }
  if (types && !state.production) {
    add("51", "compliance officer wallet 1", () =>
      types.isComplianceOfficer(state.signers[1].address),
    );
  }
  if (gov && vgt) {
    add("74", "VanguardGovernance agent on VGT", () => vgt.isAgent(gov));
    add("74", "VGT agent on IdentityRegistry (recovery)", () =>
      ir.isAgent(vgt),
    );
    add("74", "VanguardGovernance rule administrator for VSC", () =>
      rules.ruleAdministrators(vsc, gov),
    );
    add("74", "VanguardGovernance rule administrator for VGT", () =>
      rules.ruleAdministrators(vgt, gov),
    );
    // The ceremony takes ComplianceRules and this role from the deployer.
    add(
      "74",
      "deployer rule administrator for VGT (until the handover)",
      async () =>
        !same(await rules.owner(), deployer) ||
        rules.ruleAdministrators(vgt, deployer),
    );
    add("74", "VGT identity registry in ComplianceRules", async () =>
      same(await rules.tokenIdentityRegistry(vgt), await ir.getAddress()),
    );
    add("74", "VanguardGovernance trusted on VGT", () =>
      rules["isTrustedContract(address,address)"](vgt, gov),
    );
    add("74", "VGT recorded as the governance token", async () =>
      same(await rules.governanceToken(), await vgt.getAddress()),
    );
    if (types) {
      add(
        "74",
        "InvestorTypeRegistry nominated to VanguardGovernance",
        async () => {
          const g = await gov.getAddress();
          return (
            same(await types.owner(), g) || same(await types.pendingOwner(), g)
          );
        },
      );
    }
  }
  if (escrow) {
    add(
      "61",
      "escrow factory registrar on VSC",
      async () =>
        (await rules.trustedRegistrars(vsc, escrow)) ===
        (await walletCodeHash("MultiSigEscrowWallet")),
    );
    add("61", "escrow fee wallet verified", async () =>
      ir.isVerified(await escrow.ownerWallet()),
    );
    if (types) {
      // A contract fee wallet is trusted on VSC: no cap to exempt it from.
      add("61", "escrow fee wallet exempt from investor limits", async () => {
        const fee = await escrow.ownerWallet();
        return (
          (await ethers.provider.getCode(fee)) !== "0x" ||
          types.investorLimitExempt(fee)
        );
      });
    }
  }
  const out = [];
  for (const [by, name, read] of checks) {
    if (!flow || by === flow) out.push({ name, ok: await read() });
  }
  return out;
}

/**
 * The names of `state`'s wiring that does not read true on chain, with
 * `local` (a flow's contracts, not yet in state) counted in; with `flow`,
 * that option's links only.
 */
async function missingWiring(state, local = {}, flow) {
  const view = {
    production: state.production,
    signers: state.signers,
    getContract: (k) => local[k] || state.getContract(k),
  };
  return (await wiring(view, flow)).filter((w) => !w.ok).map((w) => w.name);
}

/**
 * After a deploy flow stopped: its links still missing on chain, with
 * `local` counted in, as one line. A report only: the flow rethrows its
 * own error whatever this reads.
 */
async function reportStop(state, local) {
  const missing = await missingWiring(state, local).catch(() => null);
  if (missing?.length)
    console.log(`   the deploy stopped; missing wiring: ${missing.join(", ")}`);
}

module.exports = { wiring, missingWiring, reportStop };
