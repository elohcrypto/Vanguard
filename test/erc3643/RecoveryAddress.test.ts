import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Wallet recovery must leave the new wallet usable.
 *
 * recoveryAddress moved the balance and deleted the OLD identity, but the line
 * registering the NEW wallet was commented out. The result: a successful-looking
 * recovery (returns true, emits RecoverySuccess) that leaves the entire balance
 * frozen, because every transfer requires isVerified(from).
 *
 * Two further defects on the same path:
 *   - _frozenTokens[new] was ASSIGNED, so an existing frozen balance on the new
 *     wallet was silently zeroed
 *   - the address-level _frozen flag was not carried over, so recovering a
 *     frozen address produced an unfrozen one
 */
describe("recoveryAddress", function () {
  let owner: SignerWithAddress, lost: SignerWithAddress, fresh: SignerWithAddress, other: SignerWithAddress;
  let idReg: any, rules: any, token: any, lostId: string;
  const E = (n: string) => ethers.parseEther(n);

  beforeEach(async function () {
    [owner, lost, fresh, other] = await ethers.getSigners();

    idReg = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], []);
    token = await (await ethers.getContractFactory("Token")).deploy(
      "Vanguard", "VSC", await idReg.getAddress(), await rules.getAddress()
    );
    await rules.setTokenIdentityRegistry(await token.getAddress(), await idReg.getAddress());
    await idReg.addAgent(owner.address);
    await idReg.addAgent(await token.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    lostId = await (await OID.deploy(lost.address)).getAddress();
    await idReg.registerIdentity(lost.address, lostId, 840);
    await idReg.registerIdentity(other.address, await (await OID.deploy(other.address)).getAddress(), 840);
    await token.mint(lost.address, E("1000"));
  });

  it("moves the balance to the new wallet", async function () {
    await token.recoveryAddress(lost.address, fresh.address, lostId);
    expect(await token.balanceOf(fresh.address)).to.equal(E("1000"));
    expect(await token.balanceOf(lost.address)).to.equal(0n);
  });

  it("leaves the new wallet verified, so the funds are spendable", async function () {
    await token.recoveryAddress(lost.address, fresh.address, lostId);

    expect(await idReg.isVerified(fresh.address), "recovered wallet must be verified").to.be.true;
    await expect(token.connect(fresh).transfer(other.address, E("10")))
      .to.not.be.reverted;
  });

  it("keeps the identity count stable across a recovery", async function () {
    const before = await idReg.registeredIdentityCount();
    await token.recoveryAddress(lost.address, fresh.address, lostId);
    expect(await idReg.registeredIdentityCount(), "recovery must not shrink the electorate").to.equal(before);
  });

  it("carries frozen tokens over rather than overwriting", async function () {
    await token.freezePartialTokens(lost.address, E("400"));
    await token.recoveryAddress(lost.address, fresh.address, lostId);

    expect(await token.frozenTokens(fresh.address)).to.equal(E("400"));
    expect(await token.getFreeBalance(fresh.address)).to.equal(E("600"));
  });

  it("carries the address-level freeze over", async function () {
    await token.setAddressFrozen(lost.address, true);
    await token.recoveryAddress(lost.address, fresh.address, lostId);

    expect(await token.isFrozen(fresh.address), "a frozen wallet must stay frozen after recovery").to.be.true;
  });

  it("still works after the user's country is blocked", async function () {
    // Recovery relocates an ALREADY ADMITTED user; it is not a new admission.
    // Routing it through registerIdentity's jurisdiction gate would strand the
    // funds of anyone whose country is sanctioned after they joined - exactly
    // the person most likely to need a recovery.
    await rules.setJurisdictionRule(await token.getAddress(), [840], [643]);
    await idReg.setComplianceRules(await rules.getAddress(), await token.getAddress());
    await idReg.updateCountry(lost.address, 643);

    await expect(token.recoveryAddress(lost.address, fresh.address, lostId)).to.not.be.reverted;
    expect(await idReg.isVerified(fresh.address)).to.be.true;
    expect(await token.balanceOf(fresh.address)).to.equal(E("1000"));
    // The country travels with the user, it is not silently reset.
    expect(await idReg.investorCountry(fresh.address)).to.equal(643);
  });

  // Found reviewing PR #4: the freeze carry-over was an ASSIGNMENT, so an
  // unfrozen source CLEARED a frozen destination — recovering into a
  // sanctioned address unfroze it and handed it the balance.
  it("does not clear a freeze already on the destination wallet", async function () {
    await token.setAddressFrozen(fresh.address, true);
    expect(await token.isFrozen(lost.address), "source must be unfrozen for this case").to.be.false;

    await token.recoveryAddress(lost.address, fresh.address, lostId);

    expect(await token.isFrozen(fresh.address), "an administrative freeze must survive recovery").to.be.true;
  });

  it("refuses to recover into a wallet registered to a different identity", async function () {
    await token.mint(other.address, E("50"));
    await expect(token.recoveryAddress(lost.address, other.address, lostId))
      .to.be.revertedWith("New wallet already has identity");
  });

  it("reverts cleanly when the token is not an agent of the registry", async function () {
    // moveIdentity is onlyAgent and the Token calls it as msg.sender. The
    // deploy wiring must grant this; if it is missing, the failure should be
    // an explicit revert, not a silent half-recovery.
    await idReg.removeAgent(await token.getAddress());
    const before = await token.balanceOf(lost.address);
    await expect(token.recoveryAddress(lost.address, fresh.address, lostId)).to.be.reverted;
    expect(await token.balanceOf(lost.address), "no partial state change").to.equal(before);
  });

  it("does not run while the token is paused", async function () {
    await token.pause();
    await expect(token.recoveryAddress(lost.address, fresh.address, lostId)).to.be.reverted;
  });

  // Found reviewing PR #4: the registry is shared by every token, so the first
  // token's recovery moves the person's identity and every OTHER token then saw
  // identity(lost) == 0 and reverted "Invalid identity", leaving those balances
  // on a wallet that could never transfer again.
  describe("with a second token on the same registry", function () {
    let vgt: any;

    beforeEach(async function () {
      vgt = await (await ethers.getContractFactory("Token")).deploy(
        "Gov", "VGT", await idReg.getAddress(), await rules.getAddress()
      );
      await rules.setTokenIdentityRegistry(await vgt.getAddress(), await idReg.getAddress());
      await idReg.addAgent(await vgt.getAddress());
      await vgt.mint(lost.address, E("50"));
      await token.recoveryAddress(lost.address, fresh.address, lostId); // first token moves the identity
    });

    it("still recovers the second token, even if the new wallet already holds some", async function () {
      await vgt.mint(fresh.address, E("5")); // the new wallet is already in use for this token
      await vgt.freezePartialTokens(lost.address, E("20"));
      await vgt.freezePartialTokens(fresh.address, E("1"));
      const before = await idReg.registeredIdentityCount();

      await expect(vgt.recoveryAddress(lost.address, fresh.address, lostId)).to.not.be.reverted;

      expect(await vgt.balanceOf(fresh.address)).to.equal(E("55"));
      expect(await vgt.balanceOf(lost.address)).to.equal(0n);
      expect(await vgt.frozenTokens(fresh.address), "frozen tokens accumulate, not overwrite").to.equal(E("21"));
      expect(await idReg.registeredIdentityCount()).to.equal(before);
      await expect(vgt.connect(fresh).transfer(other.address, E("10"))).to.not.be.reverted;
    });

    it("refuses if the lost wallet has since been registered to someone else", async function () {
      const OID = await ethers.getContractFactory("OnchainID");
      await idReg.registerIdentity(lost.address, await (await OID.deploy(owner.address)).getAddress(), 840);
      await expect(vgt.recoveryAddress(lost.address, fresh.address, lostId)).to.be.revertedWith("Invalid identity");
    });

    it("cannot pull an unrelated deregistered wallet into the recovered one", async function () {
      // `other` holds tokens, then is offboarded: identity(other) == 0, exactly
      // like the lost wallet after the first recovery. The sibling-token path
      // must still prove the source wallet belonged to THIS identity.
      await vgt.mint(other.address, E("30"));
      await idReg.deleteIdentity(other.address);

      await expect(vgt.recoveryAddress(other.address, fresh.address, lostId)).to.be.revertedWith("Invalid identity");
      expect(await vgt.balanceOf(other.address)).to.equal(E("30"));
    });

    it("a recycled wallet does not keep the old identity's recovery claim", async function () {
      const OID = await ethers.getContractFactory("OnchainID");
      await idReg.registerIdentity(lost.address, await (await OID.deploy(owner.address)).getAddress(), 840);
      await vgt.mint(lost.address, E("1")); // the new occupant's money
      await idReg.deleteIdentity(lost.address);

      await expect(vgt.recoveryAddress(lost.address, fresh.address, lostId)).to.be.revertedWith("Invalid identity");
    });
  });
});
