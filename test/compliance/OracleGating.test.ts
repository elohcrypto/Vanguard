import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Oracle gating (#issue: oracles existed but nothing read them).
 *
 * ComplianceRules can consult the WhitelistOracle and BlacklistOracle on every
 * transfer. Both checks are OFF until an oracle address is set, because most
 * deployments (including the demo's one-click path) never deploy an oracle and
 * must keep working unchanged.
 */
describe("Oracle gating in ComplianceRules", function () {
  let owner: SignerWithAddress, alice: SignerWithAddress, bob: SignerWithAddress;
  let idReg: any, rules: any, token: any, wl: any, bl: any;
  const E = (n: number) => ethers.parseEther(String(n));

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    idReg = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], [643]);
    token = await (await ethers.getContractFactory("Token")).deploy(
      "Vanguard", "VSC", await idReg.getAddress(), await rules.getAddress()
    );
    await rules.setTokenIdentityRegistry(await token.getAddress(), await idReg.getAddress());
    await idReg.addAgent(owner.address);

    const OID = await ethers.getContractFactory("OnchainID");
    for (const who of [alice, bob]) {
      const id = await OID.deploy(who.address);
      await idReg.registerIdentity(who.address, await id.getAddress(), 840);
    }
    await token.mint(alice.address, E(1000));

    const om = await (await ethers.getContractFactory("OracleManager")).deploy();
    wl = await (await ethers.getContractFactory("WhitelistOracle")).deploy(
      await om.getAddress(), "WL", "whitelist"
    );
    bl = await (await ethers.getContractFactory("BlacklistOracle")).deploy(
      await om.getAddress(), "BL", "blacklist"
    );
  });

  describe("default: no oracle set", function () {
    it("transfers between KYC'd parties still work (back-compat)", async function () {
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(E(10));
    });

    it("reports both gates disabled", async function () {
      const t = await token.getAddress();
      expect(await rules.blacklistOracle(t)).to.equal(ethers.ZeroAddress);
      expect(await rules.whitelistOracle(t)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("blacklist oracle set", function () {
    beforeEach(async function () {
      await rules.setBlacklistOracle(await token.getAddress(), await bl.getAddress());
    });

    it("a clean pair still transfers", async function () {
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
    });

    it("blocks a transfer TO a blacklisted address", async function () {
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      expect(await bl.isBlacklisted(bob.address)).to.be.true;
      await expect(token.connect(alice).transfer(bob.address, E(10)))
        .to.be.revertedWith("Compliance check failed");
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });

    it("blocks a transfer FROM a blacklisted address", async function () {
      await token.connect(alice).transfer(bob.address, E(10));
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      await expect(token.connect(bob).transfer(alice.address, E(5)))
        .to.be.revertedWith("Compliance check failed");
      expect(await token.balanceOf(bob.address)).to.equal(E(10));
    });

    it("an expired blacklist entry stops blocking", async function () {
      await bl.addToBlacklist(bob.address, 2, 3600, "temporary");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);
      expect(await bl.isBlacklisted(bob.address)).to.be.false;
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
    });

    it("removing from the blacklist restores transfers", async function () {
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
      await bl.removeFromBlacklist(bob.address, "cleared");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
    });

    it("unsetting the oracle disables the gate", async function () {
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
      await rules.setBlacklistOracle(await token.getAddress(), ethers.ZeroAddress);
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
    });
  });

  describe("whitelist oracle set", function () {
    beforeEach(async function () {
      await rules.setWhitelistOracle(await token.getAddress(), await wl.getAddress());
    });

    it("blocks when neither party is whitelisted (default-deny)", async function () {
      await expect(token.connect(alice).transfer(bob.address, E(10)))
        .to.be.revertedWith("Compliance check failed");
    });

    it("blocks when only the sender is whitelisted", async function () {
      await wl.addToWhitelist(alice.address, 1, 0, "kyc");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
    });

    it("allows when both are whitelisted", async function () {
      await wl.addToWhitelist(alice.address, 1, 0, "kyc");
      await wl.addToWhitelist(bob.address, 1, 0, "kyc");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(E(10));
    });

    it("an expired whitelist entry starts blocking again", async function () {
      await wl.addToWhitelist(alice.address, 1, 3600, "kyc");
      await wl.addToWhitelist(bob.address, 1, 3600, "kyc");
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);
      expect(await wl.isWhitelisted(bob.address)).to.be.false;
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
    });
  });

  describe("both oracles set", function () {
    beforeEach(async function () {
      await rules.setBlacklistOracle(await token.getAddress(), await bl.getAddress());
      await rules.setWhitelistOracle(await token.getAddress(), await wl.getAddress());
      await wl.addToWhitelist(alice.address, 1, 0, "kyc");
      await wl.addToWhitelist(bob.address, 1, 0, "kyc");
    });

    it("whitelisted pair transfers", async function () {
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.not.be.reverted;
    });

    it("blacklist beats whitelist", async function () {
      await bl.addToBlacklist(bob.address, 3, 0, "critical");
      expect(await wl.isWhitelisted(bob.address)).to.be.true;
      await expect(token.connect(alice).transfer(bob.address, E(10))).to.be.reverted;
    });
  });

  describe("mint and burn", function () {
    beforeEach(async function () {
      await rules.setBlacklistOracle(await token.getAddress(), await bl.getAddress());
      await rules.setWhitelistOracle(await token.getAddress(), await wl.getAddress());
    });

    it("minting to a blacklisted address is blocked", async function () {
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      await expect(token.mint(bob.address, E(10))).to.be.reverted;
    });

    it("burning from a blacklisted address still works (recovery path)", async function () {
      // Fund bob while he is still clean (the whitelist gate is live here, so
      // he must be listed for the mint to land), then blacklist him.
      await wl.addToWhitelist(bob.address, 1, 0, "kyc");
      await token.mint(bob.address, E(10));
      await bl.addToBlacklist(bob.address, 2, 0, "AML risk");
      expect(await bl.isBlacklisted(bob.address)).to.be.true;

      // Burn is the claw-back path and must stay open.
      await expect(token.burn(bob.address, E(10))).to.not.be.reverted;
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });
  });

  describe("trusted-contract bypass", function () {
    // Regression: the oracle gate originally sat BELOW the trusted-contract
    // branch, so a blacklisted address could launder a transfer through an
    // escrow wallet. The blacklist check now runs above that branch.
    let trusted: any;

    beforeEach(async function () {
      await rules.setBlacklistOracle(await token.getAddress(), await bl.getAddress());
      trusted = await (await ethers.getContractFactory("MockToken")).deploy("T", "T", 0);
      const tAddr = await trusted.getAddress();
      await rules.addTrustedContract(tAddr);
      const id = await (await ethers.getContractFactory("OnchainID")).deploy(owner.address);
      await idReg.registerIdentity(tAddr, await id.getAddress(), 840);
    });

    it("a blacklisted sender cannot transfer TO a trusted contract", async function () {
      await bl.addToBlacklist(alice.address, 2, 0, "sanctioned");
      await expect(token.connect(alice).transfer(await trusted.getAddress(), E(10)))
        .to.be.revertedWith("Compliance check failed");
    });

    it("a clean sender can still transfer to a trusted contract", async function () {
      await expect(token.connect(alice).transfer(await trusted.getAddress(), E(10)))
        .to.not.be.reverted;
    });
  });

  describe("whitelist is not bypassable via a trusted contract", function () {
    // The blacklist was moved above the trusted-contract branch, but the
    // whitelist was left on the normal path only, so an UNLISTED party could
    // route through an escrow wallet. The non-trusted counterparty must be
    // whitelisted; the trusted contract itself is exempt (it is a contract,
    // it will never be on an investor allow list).
    let trusted: any;

    beforeEach(async function () {
      await rules.setWhitelistOracle(await token.getAddress(), await wl.getAddress());
      trusted = await (await ethers.getContractFactory("MockToken")).deploy("T", "T", 0);
      const tAddr = await trusted.getAddress();
      await rules.addTrustedContract(tAddr);
      const id = await (await ethers.getContractFactory("OnchainID")).deploy(owner.address);
      await idReg.registerIdentity(tAddr, await id.getAddress(), 840);
    });

    it("an unlisted sender cannot transfer TO a trusted contract", async function () {
      await expect(token.connect(alice).transfer(await trusted.getAddress(), E(10)))
        .to.be.revertedWith("Compliance check failed");
    });

    it("a whitelisted sender can transfer to a trusted contract", async function () {
      await wl.addToWhitelist(alice.address, 1, 0, "kyc");
      await expect(token.connect(alice).transfer(await trusted.getAddress(), E(10)))
        .to.not.be.reverted;
    });
  });

  describe("oracle gates do not depend on identity-registry wiring", function () {
    // Both oracle checks sat inside `if (identityRegistryAddr != 0)`. An
    // operator who set a blacklist oracle but had not yet called
    // setTokenIdentityRegistry got a silent no-op.
    it("blacklist applies even when no identity registry is configured", async function () {
      // Fresh rules with NO setTokenIdentityRegistry call.
      const bare = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], []);
      const t2 = await (await ethers.getContractFactory("Token")).deploy(
        "V2", "V2", await idReg.getAddress(), await bare.getAddress()
      );
      await bare.setBlacklistOracle(await t2.getAddress(), await bl.getAddress());
      await t2.mint(alice.address, E(100));
      await bl.addToBlacklist(bob.address, 2, 0, "sanctioned");

      await expect(t2.connect(alice).transfer(bob.address, E(10)))
        .to.be.revertedWith("Compliance check failed");
    });
  });

  describe("access control", function () {
    it("only the owner can set the oracles", async function () {
      const t = await token.getAddress();
      await expect(rules.connect(alice).setBlacklistOracle(t, await bl.getAddress())).to.be.reverted;
      await expect(rules.connect(alice).setWhitelistOracle(t, await wl.getAddress())).to.be.reverted;
    });

    it("emits an event when an oracle is set", async function () {
      const t = await token.getAddress();
      await expect(rules.setBlacklistOracle(t, await bl.getAddress()))
        .to.emit(rules, "BlacklistOracleSet").withArgs(t, await bl.getAddress());
      await expect(rules.setWhitelistOracle(t, await wl.getAddress()))
        .to.emit(rules, "WhitelistOracleSet").withArgs(t, await wl.getAddress());
    });

    it("rejects a non-contract oracle address", async function () {
      await expect(rules.setBlacklistOracle(await token.getAddress(), alice.address)).to.be.reverted;
    });
  });
});
