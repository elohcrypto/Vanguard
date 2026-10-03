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

  it("Either, bound transfer, unbound refused, sender removed and refused, re-proof transfer", async function () {
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
    // Security mode 1: wallets 0-2 listed; the first verified one (1, as
    // wallet 0 is not onboarded here) proves and sends.
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
      // Wallets 1, 2 (listed) and 5 (not listed) onboard with KYC/AML.
      const idReg = state.getContract("identityRegistry");
      const OID = await ethers.getContractFactory("OnchainID");
      for (const i of [1, 2, 5]) {
        const id = await OID.deploy(s[i].address);
        await idReg.registerIdentity(s[i].address, await id.getAddress(), 840);
        await attestAll(state, await id.getAddress(), `live:${i}`);
      }
      r = await privacy.submitWhitelistMembershipProof();
    } finally {
      console.log = origLog;
    }
    const out = logged.join("\n");

    const token = state.getContract("digitalToken");
    const rules = state.getContract("complianceRules");
    const pm = state.getContract("privacyManager");
    const vsc = await token.getAddress();
    const amount = ethers.parseEther("10");

    expect(r, out).to.be.an("object");
    expect(await rules.whitelistMode(vsc), out).to.equal(2n);
    expect(r.mode).to.equal("Either");
    expect(r.recipient).to.equal(s[2].address);
    expect(r.outsider).to.equal(s[5].address);
    // (b) and (e): wallet 1 paid wallet 2 twice; it keeps one amount.
    expect(r.transferred).to.be.true;
    expect(r.reproved).to.be.true;
    expect(await token.balanceOf(s[2].address)).to.equal(2n * amount);
    expect(await token.balanceOf(s[1].address)).to.equal(amount);
    // (c) wallet 5 is verified but unbound.
    const idReg = state.getContract("identityRegistry");
    expect(r.outsiderRefused).to.be.true;
    expect(await idReg.isVerified(s[5].address)).to.be.true;
    expect(await pm.hasValidWhitelistProof(s[5].address)).to.be.false;
    expect(await token.canTransfer(s[1].address, s[5].address, amount)).to.be
      .false;
    // (d) the recipient re-bound under the rotated root, the sender could
    // not re-prove: only the sender's absence explains the refusal.
    expect(r.afterRotation).to.deep.equal({ sender: false, recipient: true });
    expect(r.rotatedRefused).to.be.true;
    expect(r.senderRemoved).to.be.true;
    // (e) both re-bound under root version 3 (bind, rotate, re-onboard).
    expect(await pm.whitelistVersion()).to.equal(3n);
    for (const i of [1, 2]) {
      expect(await pm.hasValidWhitelistProof(s[i].address)).to.be.true;
    }
    expect(await token.canTransfer(s[1].address, s[2].address, amount)).to.be
      .true;
    // The refusal hint names an unbound party, and only it.
    const { whitelistHints } = require("../../demo/utils/WhitelistLiveFlow");
    const hints = await whitelistHints(state, [s[1].address, s[5].address]);
    expect(hints).to.have.length(1);
    expect(hints[0]).to.contain("Either").and.to.contain(s[5].address);
  });
});
