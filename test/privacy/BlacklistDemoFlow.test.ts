import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 3.7: demo option 42 -> 2 on the live lists. Without a live
 * whitelist binding it stops and says so; after option 42 -> 1 the bound
 * sender proves its identity is not on the BlacklistOracle's list (wallets
 * resolved like the whitelist: OnchainID, else the wallet address as a
 * simulated identity), the wrapper verifies it, and a listed whitelist
 * member is refused by the prover. Nothing on chain gates on it (D2).
 */
describe("Blacklist proof on the live lists (demo option 42 -> 2)", function () {
  this.timeout(600_000);

  it("needs a binding, proves for the bound sender, refuses a listed member", async function () {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    const PrivacyModule = require("../../demo/modules/PrivacyModule");
    const ProofGenerator = require("../../demo/utils/ProofGenerator");
    const { attestAll } = require("../../demo/utils/Kyc");

    const state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    const s = state.signers;
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    const privacy = new PrivacyModule(
      state,
      new EnhancedLogger(),
      async () => "1",
      new ProofGenerator(state),
    );

    const logged: string[] = [];
    let before: any;
    let r: any;
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await deployer.deployAllContracts();
      await deployer.deployDigitalTokenSystem();
      await deployer.deployOracleSystem(); // option 31: the BlacklistOracle
      before = await privacy.submitBlacklistNonMembershipProof();
      const idReg = state.getContract("identityRegistry");
      const OID = await ethers.getContractFactory("OnchainID");
      for (const i of [1, 2, 5]) {
        const id = await OID.deploy(s[i].address);
        await idReg.registerIdentity(s[i].address, await id.getAddress(), 840);
        await attestAll(state, await id.getAddress(), `bl:${i}`);
      }
      await privacy.submitWhitelistMembershipProof();
      // Wallet 2 (a bound whitelist member) and wallet 6 (no OnchainID).
      const oracle = state.getContract("blacklistOracle");
      for (const i of [2, 6]) {
        await oracle.addToBlacklist(s[i].address, 1, 0, "demo sanction");
      }
      r = await privacy.submitBlacklistNonMembershipProof();
    } finally {
      console.log = origLog;
    }
    const out = logged.join("\n");

    expect(before, out).to.equal(null);
    expect(out).to.contain("run option 42 -> 1 first");
    expect(out).to.contain("Nothing on chain gates on this proof (D2)");

    expect(r, out).to.deep.equal({ verified: true, listedRefused: true });
    expect(out).to.contain(`Prover: ${s[1].address}`);
    expect(out).to.contain(
      `${s[6].address} -> its own address (simulated identity`,
    );
    expect(out).to.contain(`${s[2].address}: Identity`);
    const zk = state.getContract("zkVerifierIntegrated");
    const [total, valid] = await zk.getCircuitStats("blacklist");
    expect([total, valid]).to.deep.equal([1n, 1n]);
    // D2: the blacklist proof binds nothing; VSC still refuses wallet 2.
    const token = state.getContract("digitalToken");
    expect(await token.canTransfer(s[1].address, s[2].address, 1n)).to.equal(
      false,
    );
  });

  // Review 3.7a M1: a whitelisted wallet with no OnchainID proves under its
  // simulated identity (its address); listing it must stop its proof.
  it("a listed whitelisted wallet without an OnchainID cannot prove", async function () {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    const PrivacyModule = require("../../demo/modules/PrivacyModule");
    const ProofGenerator = require("../../demo/utils/ProofGenerator");

    const state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    const s = state.signers;
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    const privacy = new PrivacyModule(
      state,
      new EnhancedLogger(),
      async () => "1",
      new ProofGenerator(state),
    );

    const logged: string[] = [];
    let r: any;
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await deployer.deployAllContracts();
      await deployer.deployDigitalTokenSystem();
      await deployer.deployOracleSystem();
      // Demo mode, nobody onboarded: wallet 0 proves with its address.
      await privacy.submitWhitelistMembershipProof();
      const oracle = state.getContract("blacklistOracle");
      await oracle.addToBlacklist(s[0].address, 1, 0, "demo sanction");
      r = await privacy.submitBlacklistNonMembershipProof();
    } finally {
      console.log = origLog;
    }
    const out = logged.join("\n");

    const pm = state.getContract("privacyManager");
    expect(await pm.hasValidWhitelistProof(s[0].address), out).to.equal(true);
    expect(out).to.contain(`Prover: ${s[0].address}`);
    expect(out).to.contain("simulated, no OnchainID");
    expect(out).to.contain(
      `${s[0].address}'s identity is on the sanctions list: it cannot prove non-membership`,
    );
    expect(out).to.not.contain("BLACKLIST NON-MEMBERSHIP PROOF VERIFIED");
    expect(out).to.not.contain("No whitelisted wallet is listed");
    expect(r, out).to.deep.equal({ verified: false, listedRefused: true });
    const zk = state.getContract("zkVerifierIntegrated");
    const [total] = await zk.getCircuitStats("blacklist");
    expect(total).to.equal(0n);
  });
});
