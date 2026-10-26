/**
 * @fileoverview The deploy flows' wiring, read back from chain (review F-3)
 * @module DeployWiring
 * @description Options 1, 21, 31, 51, 74 and 61 wire each contract they
 * deploy (the KeyManager pin, PrivacyManager's issuer key, policies,
 * policy token and code bits, agents, rule administrators, trust, the
 * registry, jurisdiction, privacy and oracle links, the consensus engine
 * and nodes, the token's authorization, the registrars, the compliance
 * officers, the custody lock amounts, the treasury and escrow fee wallet
 * exemptions). Option 1a, each of those options but 61 (its own links)
 * and the production deploy report success only when every link below
 * reads true on chain: a contract in demo state proves it was deployed,
 * not that it was wired. A check runs only once its contracts are in
 * state; a link only a vote sets after the handover reads true once the
 * deployer no longer owns its contract.
 */

"use strict";

const { ethers } = require("hardhat");
const { walletCodeHash } = require("./GovernedCalls");
const { CIRCUITS, attestorId } = require("../../scripts/zk/attest");
const {
  DEFAULT_MINIMUM_ACCREDITATION,
  DEFAULT_COMPLIANCE,
  issuerKey,
} = require("./AttestationFlow");
const { lockAmounts } = require("./CustodyFlow");
const { ORACLE_NODES, ORACLE_REPUTATION } = require("./DeployDefaults");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Each check for `state`'s contracts: [{ name, ok }], in deploy order;
 * with `flow` ("1", "21", "31", "51", "74" or "61"), only the links that
 * option makes.
 */
async function wiring(state, flow) {
  const c = (k) => state.getContract(k);
  const [factory, km, pm, om, engine, blacklist] = [
    c("onchainIDFactory"),
    c("keyManager"),
    c("privacyManager"),
    c("oracleManager"),
    c("consensusOracle"),
    c("blacklistOracle"),
  ];
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
  const is = (read, want) => async () =>
    same(await read(), await want.getAddress());
  // `read` while the deployer owns `c`: after the handover a vote's.
  const untilHandover = (c, read) => async () =>
    !same(await c.owner(), deployer) || read();
  if (factory && km) {
    add(
      "1",
      "KeyManager recovery manager on OnchainIDFactory",
      is(() => factory.recoveryManager(), km),
    );
  }
  if (pm) {
    // The deploy's issuer key and default policies (setupDemoAttestations).
    add(
      "1",
      "issuer key trusted on PrivacyManager for each attestation circuit (until the handover)",
      untilHandover(pm, async () => {
        const { Ax, Ay } = await issuerKey(state);
        for (const { id } of Object.values(CIRCUITS)) {
          if (!(await pm.trustedAttestor(id, attestorId(Ax, Ay)))) return false;
        }
        return true;
      }),
    );
    add(
      "1",
      "PrivacyManager minimum accreditation policy (until the handover)",
      untilHandover(
        pm,
        async () =>
          (await pm.minimumAccreditation()) === DEFAULT_MINIMUM_ACCREDITATION,
      ),
    );
    add(
      "1",
      "PrivacyManager compliance aggregation policy (until the handover)",
      untilHandover(pm, async () => {
        const policy = await pm.compliancePolicy();
        return DEFAULT_COMPLIANCE.every((v, i) => policy[i] === v);
      }),
    );
  }
  if (ir && rules && vsc) {
    add("21", "VSC agent on IdentityRegistry (recovery)", () =>
      ir.isAgent(vsc),
    );
    // The ceremony takes ComplianceRules and this role from the deployer.
    add(
      "21",
      "deployer rule administrator for VSC (until the handover)",
      untilHandover(rules, () => rules.ruleAdministrators(vsc, deployer)),
    );
    // Its jurisdiction token has no getter: the rules are read back.
    add(
      "21",
      "ComplianceRules jurisdiction check on IdentityRegistry",
      is(() => ir.getComplianceRules(), rules),
    );
    if (pm) {
      add(
        "21",
        "VSC PrivacyManager in ComplianceRules",
        is(() => rules.privacyManager(vsc), pm),
      );
      // Private jurisdiction proofs take VSC's rule (wireJurisdictionSource).
      add(
        "21",
        "VSC jurisdiction policy token on PrivacyManager (until the handover)",
        untilHandover(
          pm,
          is(() => pm.policyToken(), vsc),
        ),
      );
      add(
        "21",
        "jurisdiction bit for each allowed VSC code on PrivacyManager (until the handover)",
        untilHandover(pm, async () => {
          const [, allowed] = await rules.getJurisdictionRule(vsc);
          for (const code of allowed) {
            if (!(await rules.validateJurisdiction(vsc, code))[0]) continue;
            if ((await pm.jurisdictionBit(code)) === 0n) return false;
          }
          return true;
        }),
      );
    }
  }
  if (om) {
    if (engine) {
      add(
        "31",
        "ConsensusOracle engine on OracleManager",
        is(() => om.consensusEngine(), engine),
      );
    }
    // After the handover governance's votes replace the deploy's nodes.
    add(
      "31",
      "oracle nodes registered on OracleManager (until the handover)",
      async () => {
        if (!same(await om.owner(), deployer)) return true;
        // Round 5 (G4 F4): with the deploy's name, description, reputation.
        for (const [, i, role, about] of ORACLE_NODES) {
          const o = await om.oracles(state.signers[i].address);
          if (!o.registered || o.name !== role || o.description !== about)
            return false;
          if (o.reputation !== ORACLE_REPUTATION) return false;
        }
        return true;
      },
    );
    if (rules && vsc && blacklist) {
      add(
        "31",
        "VSC blacklist oracle in ComplianceRules",
        is(() => rules.blacklistOracle(vsc), blacklist),
      );
    }
  }
  if (types && vsc) {
    add("51", "VSC investor type registry", async () =>
      same(await vsc.investorTypeRegistry(), await types.getAddress()),
    );
    add("51", "VSC authorized on InvestorTypeRegistry", () =>
      types.isTokenAuthorized(vsc),
    );
    // After the handover naming it is a ComplianceRules vote: option 51
    // prints the pending proposal, and stops on a refused one.
    add(
      "51",
      "InvestorRequestManager (custody) registrar on VSC (until the handover)",
      irm
        ? untilHandover(
            rules,
            async () =>
              (await rules.trustedRegistrars(vsc, irm)) ===
              (await walletCodeHash("MultiSigWallet")),
          )
        : async () => false,
    );
    add("51", "InvestorRequestManager compliance officer", async () =>
      irm ? types.isComplianceOfficer(irm) : false,
    );
    const banks = [...(state.bankingInstitutions?.values() || [])].filter(
      (b) => b.type === "CENTRAL_BANK",
    );
    if (banks.length) {
      // After the handover only governance exempts a treasury (D22).
      add(
        "51",
        "central bank exempt from investor limits (until the handover)",
        async () => {
          if (!same(await types.owner(), deployer)) return true;
          for (const b of banks) {
            if (!(await types.investorLimitExempt(b.address))) return false;
          }
          return true;
        },
      );
    }
    add("51", "custody lock requirements as configured", async () => {
      if (!irm) return false;
      // The demo's amounts follow the Normal cap, a vote's after the handover.
      const set = state.production?.lockRequirements;
      if (!set && !same(await types.owner(), deployer)) return true;
      const cap = (await types.getInvestorTypeConfig(0)).maxTransferAmount;
      const locks = lockAmounts(state, cap);
      for (const [i, t] of [1, 2, 3].entries()) {
        if ((await irm.lockRequirements(t)) !== BigInt(locks[i])) return false;
      }
      return true;
    });
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
    attestorKey: state.attestorKey,
    signers: state.signers,
    bankingInstitutions: state.bankingInstitutions,
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

/**
 * Round 5 (lane D-3): `c` deployed with code at its address, else a stop
 * naming it (its deploy mined without creating the contract), before
 * anything holds `c`: demo state never gets an address without code.
 */
async function deployed(c, name) {
  await c.waitForDeployment();
  const at = await c.getAddress();
  if ((await ethers.provider.getCode(at)) === "0x") {
    throw new Error(
      `${name} at ${at} has no code: its deploy transaction mined without creating it`,
    );
  }
  return c;
}

module.exports = { wiring, missingWiring, reportStop, deployed };
