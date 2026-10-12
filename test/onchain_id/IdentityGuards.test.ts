import { expect } from "chai";
import { ethers } from "hardhat";

// Task 4.15 (C §2 OnchainIDKeys, OnchainIDOwnership, KeyManagerRecovery
// and ClaimIssuerKeys rows; C §3 N37/b/c, N80). An executed request is
// never approved or paid again; initialize and authorizeManager keep
// their zero and owner checks; KeyManager refuses a codeless identity;
// ClaimIssuer's trusted-issuer admin needs a MANAGEMENT key and its
// switches are the owner's.
const MGMT = 1;
const ACTION = 2;
const ECDSA = 1;
const keyOf = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);

describe("Identity guards (Task 4.15)", function () {
  describe("OnchainID execution requests", function () {
    async function setup() {
      const [owner, a, b, c, stranger] = await ethers.getSigners();
      const id = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(owner.address);
      for (const w of [a, b, c])
        await id.connect(owner).addKey(keyOf(w.address), ACTION, ECDSA);
      const tok = await (
        await ethers.getContractFactory("MockToken")
      ).deploy("M", "M", 0);
      await tok.mint(await id.getAddress(), 500n);
      const data = tok.interface.encodeFunctionData("transfer", [
        a.address,
        500n,
      ]);
      return { owner, a, b, c, stranger, id, tok, data };
    }

    it("a request executed at the threshold is not approved or paid again (N37/b/c)", async function () {
      const { a, b, c, id, tok, data } = await setup();
      expect(await id.executionThreshold()).to.equal(2);
      await id.connect(a).execute(await tok.getAddress(), 0, data);
      await tok.mint(await id.getAddress(), 500n); // a second payment's worth
      await expect(id.connect(b).approve(0, true)).to.emit(id, "Executed");
      expect(await tok.balanceOf(a.address)).to.equal(500n);
      await expect(id.connect(c).approve(0, true)).to.be.revertedWith(
        "OnchainID: Already executed",
      );
      await expect(id.connect(c).approve(0, false)).to.be.revertedWith(
        "OnchainID: Already executed",
      );
      expect(await tok.balanceOf(a.address)).to.equal(500n);
      expect(await tok.balanceOf(await id.getAddress())).to.equal(500n);
    });

    it("approve refuses an unknown request and a key with no ACTION purpose", async function () {
      const { a, stranger, id, tok, data } = await setup();
      await expect(id.connect(a).approve(7, true)).to.be.revertedWith(
        "OnchainID: Execution request does not exist",
      );
      await id.connect(a).execute(await tok.getAddress(), 0, data);
      await expect(id.connect(stranger).approve(0, true)).to.be.revertedWith(
        "OnchainID: Sender does not have action key",
      );
      await expect(
        id.connect(stranger).execute(await tok.getAddress(), 0, data),
      ).to.be.revertedWith("OnchainID: Sender does not have action key");
    });
  });

  describe("OnchainID initialize and managers", function () {
    it("initialize: never to the zero owner, never twice (195)", async function () {
      const [owner, other] = await ethers.getSigners();
      const OID = await ethers.getContractFactory("OnchainID");
      const id = await OID.deploy(ethers.ZeroAddress);
      expect(await id.owner()).to.equal(await id.getAddress()); // unowned
      await expect(
        id.initialize(ethers.ZeroAddress, keyOf(owner.address)),
      ).to.be.revertedWith("OnchainID: Invalid owner");
      await id.initialize(owner.address, keyOf(owner.address));
      expect(await id.owner()).to.equal(owner.address);
      await expect(
        id.initialize(other.address, keyOf(other.address)),
      ).to.be.revertedWith("OnchainID: Already initialized");
      const direct = await OID.deploy(owner.address);
      await expect(
        direct.initialize(other.address, keyOf(other.address)),
      ).to.be.revertedWith("OnchainID: Already initialized");
    });

    it("authorizeManager and deauthorizeManager are the owner's; no zero manager (218)", async function () {
      const [owner, stranger, mgr] = await ethers.getSigners();
      const id = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(owner.address);
      await expect(
        id.connect(stranger).authorizeManager(mgr.address),
      ).to.be.revertedWith("OnchainID: Only owner can authorize managers");
      await expect(id.authorizeManager(ethers.ZeroAddress)).to.be.revertedWith(
        "OnchainID: Invalid manager address",
      );
      await id.authorizeManager(mgr.address);
      await expect(
        id.connect(stranger).deauthorizeManager(mgr.address),
      ).to.be.revertedWith("OnchainID: Only owner can deauthorize managers");
      expect(await id.authorizedManagers(mgr.address)).to.equal(true);
    });
  });

  describe("KeyManager", function () {
    it("executeKeyRecovery refuses an identity with no code: IdentityNotAContract (329)", async function () {
      const [, eoa] = await ethers.getSigners();
      const km = await (await ethers.getContractFactory("KeyManager")).deploy();
      await expect(
        km.executeKeyRecovery(eoa.address, keyOf(eoa.address)),
      ).to.be.revertedWithCustomError(km, "IdentityNotAContract");
    });
  });

  describe("ClaimIssuer admin", function () {
    async function setup() {
      const [owner, mgr, stranger, other] = await ethers.getSigners();
      const issuer = await (
        await ethers.getContractFactory("ClaimIssuer")
      ).deploy(owner.address, "KYC", "KYC issuer");
      const peer = await (
        await ethers.getContractFactory("ClaimIssuer")
      ).deploy(other.address, "AML", "AML issuer");
      return { owner, mgr, stranger, issuer, peer: await peer.getAddress() };
    }

    it("trusted-issuer admin needs a MANAGEMENT key (142/167); a non-owner key passes", async function () {
      const { owner, mgr, stranger, issuer, peer } = await setup();
      const NO_KEY = "ClaimIssuer: Sender does not have management key";
      await expect(
        issuer.connect(stranger).addTrustedIssuer(peer, [6]),
      ).to.be.revertedWith(NO_KEY);
      await expect(
        issuer.connect(stranger).removeTrustedIssuer(peer),
      ).to.be.revertedWith(NO_KEY);
      await expect(
        issuer.addTrustedIssuer(ethers.ZeroAddress, [6]),
      ).to.be.revertedWith("ClaimIssuer: Invalid issuer");
      await issuer.connect(owner).addIssuerKey(keyOf(mgr.address), MGMT, ECDSA);
      await expect(issuer.connect(mgr).addTrustedIssuer(peer, [6]))
        .to.emit(issuer, "TrustedIssuerAdded")
        .withArgs(peer, [6]);
      await expect(issuer.connect(mgr).removeTrustedIssuer(peer))
        .to.emit(issuer, "TrustedIssuerRemoved")
        .withArgs(peer);
    });

    it("setActive and setIssuerInfo are the owner's (N80)", async function () {
      const { mgr, stranger, issuer } = await setup();
      await issuer.addIssuerKey(keyOf(mgr.address), MGMT, ECDSA);
      for (const who of [stranger, mgr]) {
        await expect(issuer.connect(who).setActive(false))
          .to.be.revertedWithCustomError(issuer, "OwnableUnauthorizedAccount")
          .withArgs(who.address);
        await expect(issuer.connect(who).setIssuerInfo("x", "y", "z"))
          .to.be.revertedWithCustomError(issuer, "OwnableUnauthorizedAccount")
          .withArgs(who.address);
      }
      expect(await issuer.isActive()).to.equal(true);
      await issuer.setActive(false);
      expect(await issuer.isActive()).to.equal(false);
    });
  });
});
