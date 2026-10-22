/**
 * @fileoverview The deploy flows' wiring, read back from chain (review F-3)
 * @module DeployWiring
 * @description Options 74, 51 and 61 wire each contract they deploy
 * (agents, rule administrators, trust, the registry links, the
 * registrars, the compliance officers). Option 1a and the production
 * deploy report success only when every link below reads true on chain:
 * a contract in demo state proves it was deployed, not that it was wired.
 * A check runs only once its contracts are in state, so it holds before
 * and after the handover.
 */

"use strict";

const { walletCodeHash } = require("./GovernedCalls");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** Each check for `state`'s contracts: [{ name, ok }], in deploy order. */
async function wiring(state) {
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
  const checks = [];
  const add = (name, read) => checks.push([name, read]);
  if (types && vsc) {
    add("VSC investor type registry", async () =>
      same(await vsc.investorTypeRegistry(), await types.getAddress()),
    );
    add("InvestorRequestManager (custody) registrar on VSC", async () =>
      irm
        ? (await rules.trustedRegistrars(vsc, irm)) ===
          (await walletCodeHash("MultiSigWallet"))
        : false,
    );
    add("InvestorRequestManager compliance officer", async () =>
      irm ? types.isComplianceOfficer(irm) : false,
    );
  }
  if (types && !state.production) {
    add("compliance officer wallet 1", () =>
      types.isComplianceOfficer(state.signers[1].address),
    );
  }
  if (gov && vgt) {
    add("VanguardGovernance agent on VGT", () => vgt.isAgent(gov));
    add("VGT agent on IdentityRegistry (recovery)", () => ir.isAgent(vgt));
    add("VanguardGovernance rule administrator for VSC", () =>
      rules.ruleAdministrators(vsc, gov),
    );
    add("VanguardGovernance rule administrator for VGT", () =>
      rules.ruleAdministrators(vgt, gov),
    );
    add("VGT identity registry in ComplianceRules", async () =>
      same(await rules.tokenIdentityRegistry(vgt), await ir.getAddress()),
    );
    add("VanguardGovernance trusted on VGT", () =>
      rules["isTrustedContract(address,address)"](vgt, gov),
    );
    add("VGT recorded as the governance token", async () =>
      same(await rules.governanceToken(), await vgt.getAddress()),
    );
    if (types) {
      add("InvestorTypeRegistry nominated to VanguardGovernance", async () => {
        const g = await gov.getAddress();
        return (
          same(await types.owner(), g) || same(await types.pendingOwner(), g)
        );
      });
    }
  }
  if (escrow) {
    add(
      "escrow factory registrar on VSC",
      async () =>
        (await rules.trustedRegistrars(vsc, escrow)) ===
        (await walletCodeHash("MultiSigEscrowWallet")),
    );
  }
  const out = [];
  for (const [name, read] of checks) out.push({ name, ok: await read() });
  return out;
}

/** The names of `state`'s wiring that does not read true on chain. */
async function missingWiring(state) {
  return (await wiring(state)).filter((w) => !w.ok).map((w) => w.name);
}

module.exports = { wiring, missingWiring };
