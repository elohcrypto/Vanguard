import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc, deployIdentity } from "../helpers/kyc";

/**
 * Task 2A.3: Token.canTransfer is an ERC-3643 predicate. It used `require`
 * inside a `view returns (bool)`, so every disallowed case reverted instead
 * of returning false. canTransfer must now return false without reverting,
 * while transfer() still reverts with the same reason string.
 */
describe("Token.canTransfer is a predicate", function () {
  let owner: SignerWithAddress,
    alice: SignerWithAddress,
    bob: SignerWithAddress,
    stranger: SignerWithAddress;
  let idReg: any, rules: any, token: any;
  const E = (n: string) => ethers.parseEther(n);

  beforeEach(async function () {
    [owner, alice, bob, stranger] = await ethers.getSigners();

    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard",
      "VSC",
      await idReg.getAddress(),
      await rules.getAddress(),
    );
    await rules.setTokenIdentityRegistry(
      await token.getAddress(),
      await idReg.getAddress(),
    );
    await idReg.addAgent(owner.address);
    await idReg.addAgent(await token.getAddress());

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(owner.address);
    for (const who of [alice, bob]) {
      const id = await deployIdentity(factory, who.address);
      await idReg.registerIdentity(who.address, id, 840);
      await attest(kycIssuer, owner, id);
    }
    await token.mint(alice.address, E("100"));
  });

  it("returns true on the happy path", async function () {
    expect(await token.canTransfer(alice.address, bob.address, E("10"))).to.be
      .true;
  });

  it("returns false (no revert) for an unverified sender", async function () {
    expect(await token.canTransfer(stranger.address, bob.address, 0n)).to.be
      .false;
  });

  it("returns false (no revert) for an unverified recipient", async function () {
    expect(await token.canTransfer(alice.address, stranger.address, E("10")))
      .to.be.false;
  });

  it("returns false (no revert) for a frozen sender", async function () {
    await token.setAddressFrozen(alice.address, true);
    expect(await token.canTransfer(alice.address, bob.address, E("10"))).to.be
      .false;
  });

  it("returns false (no revert) for a frozen recipient", async function () {
    await token.setAddressFrozen(bob.address, true);
    expect(await token.canTransfer(alice.address, bob.address, E("10"))).to.be
      .false;
  });

  it("returns false (no revert) for insufficient balance", async function () {
    expect(await token.canTransfer(alice.address, bob.address, E("101"))).to.be
      .false;
  });

  describe("transfer still reverts with the reason", function () {
    it("Sender not verified", async function () {
      // Unverified sender holding tokens: deregister after minting.
      await idReg.deleteIdentity(alice.address);
      await expect(
        token.connect(alice).transfer(bob.address, E("1")),
      ).to.be.revertedWith("Sender not verified");
    });

    it("Recipient not verified", async function () {
      await expect(
        token.connect(alice).transfer(stranger.address, E("1")),
      ).to.be.revertedWith("Recipient not verified");
    });

    it("frozen sender reverts (whenNotFrozen fires first)", async function () {
      // transfer() and transferFrom() both carry whenNotFrozen(sender) ahead
      // of whenTransferAllowed, so a frozen sender is refused with the
      // modifier's "Address is frozen" before _checkTransfer can report
      // "Sender frozen". This ordering predates 2A.3 and is unchanged.
      await token.setAddressFrozen(alice.address, true);
      await expect(
        token.connect(alice).transfer(bob.address, E("1")),
      ).to.be.revertedWith("Address is frozen");
    });

    it("Recipient frozen", async function () {
      await token.setAddressFrozen(bob.address, true);
      await expect(
        token.connect(alice).transfer(bob.address, E("1")),
      ).to.be.revertedWith("Recipient frozen");
    });

    it("Sender not verified outranks Insufficient balance (Task 2A.7)", async function () {
      // Compliance now runs before the balance check; the identity reason
      // must still win when the sender is unverified AND overspends.
      await idReg.deleteIdentity(alice.address);
      expect(await token.canTransfer(alice.address, bob.address, E("101"))).to
        .be.false;
      await expect(
        token.connect(alice).transfer(bob.address, E("101")),
      ).to.be.revertedWith("Sender not verified");
    });

    it("Insufficient balance", async function () {
      await expect(
        token.connect(alice).transfer(bob.address, E("101")),
      ).to.be.revertedWith("Insufficient balance");
    });
  });
});
