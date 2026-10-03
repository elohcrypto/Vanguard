import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 3.6: demo option 42 -> 1 on the live token. The privacy
 * pair option 1 deploys, wired by option 21; the menu path binds wallet 0
 * with a real PLONK proof, then demo/utils/WhitelistLiveFlow.js switches
 * VSC to Either, transfers, shows an unbound wallet refused, rotates the
 * root (refused), re-onboards and re-proves (transfer again). Every value
 * below is read from the chain.
 */
describe("Whitelist live flow on VSC (demo option 42 -> 1)", function () {
  this.timeout(300_000);

  it("Either, bound transfer, unbound refused, rotation refused, re-proof transfer", async function () {
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
    // Security mode 1: wallets 0-2 listed, wallet 0 proves.
    const privacy = new PrivacyModule(
      state,
      new EnhancedLogger(),
      async () => "1",
      new ProofGenerator(state),
    );

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await deployer.deployAllContracts();
      await deployer.deployDigitalTokenSystem();
      // Wallets 0-2 (listed) and 5 (not listed) onboard with KYC/AML.
      const idReg = state.getContract("identityRegistry");
      const OID = await ethers.getContractFactory("OnchainID");
      for (const i of [0, 1, 2, 5]) {
        const id = await OID.deploy(s[i].address);
        await idReg.registerIdentity(s[i].address, await id.getAddress(), 840);
        await attestAll(state, await id.getAddress(), `live:${i}`);
      }
      await privacy.submitWhitelistMembershipProof();
    } finally {
      console.log = origLog;
    }
    const out = logged.join("\n");

    const token = state.getContract("digitalToken");
    const rules = state.getContract("complianceRules");
    const pm = state.getContract("privacyManager");
    const vsc = await token.getAddress();
    const amount = ethers.parseEther("10");

    expect(await rules.whitelistMode(vsc), out).to.equal(2n);
    expect(out).to.match(/\(a\)[\s\S]*no whitelist oracle bound/);
    // (b) and (e): wallet 0 paid wallet 1 twice; it keeps one amount.
    expect(await token.balanceOf(s[1].address)).to.equal(2n * amount);
    expect(await token.balanceOf(s[0].address)).to.equal(amount);
    // (c) wallet 5 is verified but unbound.
    const idReg = state.getContract("identityRegistry");
    expect(await idReg.isVerified(s[5].address)).to.be.true;
    expect(await pm.hasValidWhitelistProof(s[5].address)).to.be.false;
    expect(await token.canTransfer(s[0].address, s[5].address, amount)).to.be
      .false;
    expect(out).to.match(/\(c\)[\s\S]*Compliance check failed/);
    // (d) the rotation refused wallet 0, which could not re-prove.
    expect(out).to.match(
      /\(d\)[\s\S]*hasValidWhitelistProof\(sender\): false[\s\S]*canTransfer\([^)]*\): false[\s\S]*cannot re-prove/,
    );
    // (e) both re-bound under root version 3 (bind, rotate, re-onboard).
    expect(await pm.whitelistVersion()).to.equal(3n);
    for (const i of [0, 1]) {
      expect(await pm.hasValidWhitelistProof(s[i].address)).to.be.true;
    }
    expect(await token.canTransfer(s[0].address, s[1].address, amount)).to.be
      .true;
    expect(out).to.match(/re-proved -> transfer/);
  });
});
