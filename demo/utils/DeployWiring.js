/**
 * @fileoverview The deploy flows' wiring, read back from chain (review F-3)
 * @module DeployWiring
 * @description Options 1, 13, 21, 31, 51, 74, 61 and 84 wire each
 * contract they deploy (the KeyManager pin, PrivacyManager's issuer key,
 * policies, policy token and code bits, agents, rule administrators,
 * trust, the registry, jurisdiction, privacy and oracle links, the
 * consensus engine and nodes, the token's authorization, the registrars,
 * the compliance officers, the custody lock amounts, the treasury and
 * escrow fee wallet exemptions, the dynamic list manager's governance).
 * Round 7 (lane D D6 args): the constructor arguments a getter reads back
 * (the issuers' and ComplianceRules' owner, the custody bank and token,
 * the escrow fee wallet, governance's bound targets) are links too.
 * Round 8 (GA-ARGS): so are the address arguments a getter reads (the list
 * oracles' manager, the custody and escrow registries, token and rules;
 * C2: both tokens' registry and compliance), a vote's once settable.
 * Option 1a, each of those options and the production deploy report
 * success only when every link below reads true on chain: a contract in
 * demo state proves it was deployed, not that it was wired. A check runs
 * only once its contracts are in state; a link only a vote sets after the
 * handover reads true once the deployer no longer owns its contract.
 */

"use strict";

const { ethers } = require("hardhat");
const { walletCodeHash } = require("./GovernedCalls");
const { isCodeOf } = require("./HandoverCodeHash");
const { CIRCUITS, attestorId } = require("../../scripts/zk/attest");
const {
  DEFAULT_MINIMUM_ACCREDITATION,
  DEFAULT_COMPLIANCE,
  issuerKey,
} = require("./AttestationFlow");
const { lockAmounts, bankSigner } = require("./CustodyFlow");
const { ORACLE_NODES, ORACLE_REPUTATION } = require("./DeployDefaults");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Each check for `state`'s contracts: [{ name, ok }], in deploy order;
 * with `flow` ("1", "13", "21", "31", "51", "74", "61" or "84"), only the
 * links that option makes; with `only`, the names it accepts.
 */
async function wiring(state, flow, only = () => true) {
  const c = (k) => state.getContract(k);
  const [factory, km, pm, om, engine, whitelist, blacklist] = [
    c("onchainIDFactory"),
    c("keyManager"),
    c("privacyManager"),
    c("oracleManager"),
    c("consensusOracle"),
    c("whitelistOracle"),
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
  const [kyc, aml, dlm] = [
    c("kycIssuer"),
    c("amlIssuer"),
    c("dynamicListManager"),
  ];
  const deployer = state.signers[0].address;
  const checks = [];
  const add = (by, name, read) => checks.push([by, name, read]);
  const is = (read, want) => async () =>
    same(await read(), await want.getAddress());
  // `read` while the deployer owns `c`: after the handover a vote's.
  const untilHandover = (c, read) => async () =>
    !same(await c.owner(), deployer) || read();
  // Round 8 (GA-ARGS): `x`'s address argument `field` reads `want`;
  // `settable` (an owner setter moves it): until the handover.
  const asDeployed = (by, label, x, field, want, settable) => {
    if (!x || !want) return;
    const read = is(() => x[field](), want);
    const name = `${label} ${field} as deployed`;
    add(by, name, settable ? untilHandover(x, read) : read);
  };
  if (kyc && aml) {
    // Round 7 (lane D D6 args): the ceremony hands the issuers to the
    // issuer admin when it takes ComplianceRules from the deployer.
    add(
      "1",
      "KYC and AML ClaimIssuers owned by the deployer (until the handover)",
      async () =>
        (rules && !same(await rules.owner(), deployer)) ||
        (same(await kyc.owner(), deployer) &&
          same(await aml.owner(), deployer)),
    );
  }
  if (rules) {
    // Round 7 (lane D D6 args): the ceremony hands it to governance.
    add(
      "13",
      "ComplianceRules owned by the deployer (until the handover)",
      async () => {
        const owner = await rules.owner();
        return (
          same(owner, deployer) ||
          Boolean(gov && same(owner, await gov.getAddress()))
        );
      },
    );
  }
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
    asDeployed("21", "Token", vsc, "identityRegistry", ir, true);
    asDeployed("21", "Token", vsc, "compliance", rules, true);
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
    asDeployed("31", "WhitelistOracle", whitelist, "oracleManager", om);
    asDeployed("31", "BlacklistOracle", blacklist, "oracleManager", om);
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
  if (irm && vsc) {
    // Round 7 (lane D D6 args): both are immutables set at construction.
    add(
      "51",
      "InvestorRequestManager bank (ops) and VSC as deployed",
      async () =>
        same(await irm.bank(), bankSigner(state).address) &&
        same(await irm.token(), await vsc.getAddress()),
    );
  }
  asDeployed("51", "InvestorRequestManager", irm, "identityRegistry", ir);
  if (types && !state.production) {
    add("51", "compliance officer wallet 1", () =>
      types.isComplianceOfficer(state.signers[1].address),
    );
  }
  if (gov) {
    // Round 7 (lane D D6 args): option 74 binds the targets in state at
    // construction, the zero address for an absent one; no setter moves them.
    const at = async (x) => (x ? x.getAddress() : ethers.ZeroAddress);
    add(
      "74",
      "VanguardGovernance's investor type registry, ComplianceRules, OracleManager and VSC as deployed",
      async () =>
        same(await gov.investorTypeRegistry(), await at(types)) &&
        same(await gov.complianceRules(), await at(rules)) &&
        same(await gov.oracleManager(), await at(om)) &&
        same(await gov.token(), await at(vsc)),
    );
  }
  asDeployed("74", "VanguardGovernance", gov, "governanceToken", vgt);
  asDeployed("74", "VanguardGovernance", gov, "identityRegistry", ir);
  asDeployed("74", "GovernanceToken", vgt, "identityRegistry", ir, true);
  asDeployed("74", "GovernanceToken", vgt, "compliance", rules, true);
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
    const f = "EscrowWalletFactory";
    asDeployed("61", f, escrow, "vscToken", vsc);
    asDeployed("61", f, escrow, "identityRegistry", ir, true);
    asDeployed("61", f, escrow, "complianceRules", rules, true);
    // Round 7 (lane D D6 args): the constructor's fee wallet; the owner's
    // setOwnerWallet after the handover.
    add(
      "61",
      "escrow fee wallet as configured (until the handover)",
      untilHandover(escrow, async () =>
        same(
          await escrow.ownerWallet(),
          (state.production?.escrowFeeWallet ?? state.signers[1]).address,
        ),
      ),
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
  if (dlm && gov) {
    // Round 7 (lane D D6): option 84's two governance links.
    add(
      "84",
      "DynamicListManager governed by VanguardGovernance",
      is(() => dlm.governanceContract(), gov),
    );
    add(
      "84",
      "DynamicListManager registered on VanguardGovernance",
      is(() => gov.dynamicListManager(), dlm),
    );
  }
  const out = [];
  for (const [by, name, read] of checks) {
    if ((!flow || by === flow) && only(name)) {
      out.push({ name, ok: await read() });
    }
  }
  return out;
}

/**
 * The names of `state`'s wiring that does not read true on chain, with
 * `local` (a flow's contracts, not yet in state) counted in; with `flow`,
 * that option's links only (and with `only`, the names it accepts).
 */
async function missingWiring(state, local = {}, flow, only) {
  const view = {
    production: state.production,
    attestorKey: state.attestorKey,
    signers: state.signers,
    bankingInstitutions: state.bankingInstitutions,
    getContract: (k) => local[k] || state.getContract(k),
  };
  return (await wiring(view, flow, only))
    .filter((w) => !w.ok)
    .map((w) => w.name);
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
 * Round 6 (G4): and that code is `artifact`'s, its immutables aside, with
 * the masked comparison the handover's code-hash pins use (the record's
 * own checkCode compares a recorded hash, not an artifact).
 */
async function deployed(c, name, artifact = name) {
  await c.waitForDeployment();
  const at = await c.getAddress();
  const code = await ethers.provider.getCode(at);
  if (code === "0x") {
    throw new Error(
      `${name} at ${at} has no code: its deploy transaction mined without creating it`,
    );
  }
  if (!(await isCodeOf(code, artifact))) {
    throw new Error(
      `${name} at ${at} has code that is not ${artifact}'s: its deploy transaction created another contract`,
    );
  }
  return c;
}

module.exports = { wiring, missingWiring, reportStop, deployed };
