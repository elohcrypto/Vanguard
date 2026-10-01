const { expect } = require("chai");
const { ethers } = require("hardhat");

// Plan v2 §6F Task 2F.2 (H2), from the reviewer's probe-c/p1: anyone could
// fill the first 8 claim ids of a topic on any identity (OnchainID.addClaim
// accepts msg.sender == _issuer), and IdentityRegistry scanned only those 8,
// so a stranger made any holder unverified. Verification now asks each
// trusted issuer, never the identity's claim list.

const KYC = 6;
const DATA = ethers.toUtf8Bytes("KYC_OK");

async function sign(signer, identity, topic, data) {
  const h = ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes"],
    [identity, topic, data],
  );
  return signer.signMessage(ethers.getBytes(h));
}

const idSideId = (issuer, topic, data) =>
  ethers.solidityPackedKeccak256(
    ["address", "uint256", "bytes"],
    [issuer, topic, data],
  );

describe("Claim-slot squatting (2F.2, H2)", function () {
  let issuerOwner, victim, attacker, ir, kyc, kycAddr, id, idAddr, OID;

  beforeEach(async function () {
    [, issuerOwner, victim, attacker] = await ethers.getSigners();
    ir = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    kyc = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(issuerOwner.address, "KYC", "kyc");
    kycAddr = await kyc.getAddress();
    await ir.addClaimTopic(KYC);
    await ir.addTrustedIssuer(kycAddr, [KYC]);
    OID = await ethers.getContractFactory("OnchainID");
    id = await OID.deploy(victim.address);
    idAddr = await id.getAddress();
    await ir.registerIdentity(victim.address, idAddr, 840);
  });

  async function issue(data = DATA, validTo = 0) {
    const sig = await sign(issuerOwner, idAddr, KYC, data);
    return kyc
      .connect(issuerOwner)
      .issueClaim(idAddr, KYC, 1, data, "", validTo, sig);
  }

  async function junk(n, from = attacker) {
    for (let i = 0; i < n; i++) {
      await id
        .connect(from)
        .addClaim(
          KYC,
          1,
          from.address,
          "0x",
          ethers.toUtf8Bytes("junk" + i),
          "",
        );
    }
  }

  it("8 junk claims by a stranger no longer unverify the holder", async function () {
    await junk(8);
    await issue();
    expect((await id.getClaimIdsByTopic(KYC)).length).to.equal(9);
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });

  it("a real claim behind 1,000 junk ids still verifies", async function () {
    this.timeout(300000);
    // batchAddClaims caps at 50 per call; 20 batches of 50 distinct ids.
    for (let b = 0; b < 20; b++) {
      const n = 50;
      const data = Array.from({ length: n }, (_, i) =>
        ethers.toUtf8Bytes(`j${b}-${i}`),
      );
      await id
        .connect(attacker)
        .batchAddClaims(
          Array(n).fill(KYC),
          Array(n).fill(1),
          Array(n).fill(attacker.address),
          Array(n).fill("0x"),
          data,
          Array(n).fill(""),
        );
    }
    await issue();
    expect((await id.getClaimIdsByTopic(KYC)).length).to.equal(1001);
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });

  it("a duplicate claim id is stored once and updated in place", async function () {
    const dup = ethers.toUtf8Bytes("dup");
    await id
      .connect(attacker)
      .addClaim(KYC, 1, attacker.address, "0x", dup, "a");
    await id
      .connect(attacker)
      .addClaim(KYC, 1, attacker.address, "0x", dup, "b");
    const cid = idSideId(attacker.address, KYC, dup);
    const ids = await id.getClaimIdsByTopic(KYC);
    expect(ids.filter((x) => x === cid).length).to.equal(1);
    expect((await id.getAllClaims()).filter((x) => x === cid).length).to.equal(
      1,
    );
    expect((await id.getClaim(cid)).uri).to.equal("b");

    // One removal clears it completely.
    await id.connect(victim).removeClaim(cid);
    expect(await id.getClaimIdsByTopic(KYC)).to.not.include(cid);
    await expect(id.connect(victim).removeClaim(cid)).to.be.revertedWith(
      "OnchainID: Claim does not exist",
    );
  });

  it("removeClaim costs the same with 50 or 300 junk claims (O(1))", async function () {
    this.timeout(300000);
    const mk = async (n) => {
      const fresh = await OID.deploy(victim.address);
      for (let b = 0; b < n / 50; b++) {
        const data = Array.from({ length: 50 }, (_, i) =>
          ethers.toUtf8Bytes(`j${b}-${i}`),
        );
        await fresh
          .connect(attacker)
          .batchAddClaims(
            Array(50).fill(KYC),
            Array(50).fill(1),
            Array(50).fill(attacker.address),
            Array(50).fill("0x"),
            data,
            Array(50).fill(""),
          );
      }
      // Remove the LAST junk id: the old linear loops scanned every entry
      // before it, so this is their worst case.
      const last = `j${n / 50 - 1}-49`;
      const cid = idSideId(attacker.address, KYC, ethers.toUtf8Bytes(last));
      const r = await (await fresh.connect(victim).removeClaim(cid)).wait();
      return r.gasUsed;
    };
    const small = await mk(50);
    const big = await mk(300);
    const diff = big > small ? big - small : small - big;
    expect(diff).to.be.lessThan(5000n);
  });

  it("revokeClaim removes the identity-side claim and unverifies at once", async function () {
    await issue();
    expect(await ir.isVerified(victim.address)).to.equal(true);
    const issuerId = ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [kycAddr, idAddr, KYC, DATA],
    );
    const sideId = idSideId(kycAddr, KYC, DATA);
    expect(await id.getClaimIdsByTopic(KYC)).to.include(sideId);

    await expect(kyc.connect(issuerOwner).revokeClaim(issuerId)).to.not.emit(
      kyc,
      "ClaimRemovalFailed",
    );
    expect(await id.getClaimIdsByTopic(KYC)).to.not.include(sideId);
    expect(await ir.isVerified(victim.address)).to.equal(false);
  });

  it("revokeClaim reports, not hides, a failed identity-side removal", async function () {
    await issue();
    const issuerId = ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [kycAddr, idAddr, KYC, DATA],
    );
    const sideId = idSideId(kycAddr, KYC, DATA);
    // The holder already removed the claim from the identity.
    await id.connect(victim).removeClaim(sideId);
    await expect(kyc.connect(issuerOwner).revokeClaim(issuerId))
      .to.emit(kyc, "ClaimRemovalFailed")
      .withArgs(idAddr, sideId);
    expect(await ir.isVerified(victim.address)).to.equal(false);
  });

  it("an issuer may remove only its own claim from an identity", async function () {
    await issue();
    const sideId = idSideId(kycAddr, KYC, DATA);
    await expect(id.connect(attacker).removeClaim(sideId)).to.be.revertedWith(
      "OnchainID: Not authorized to remove claim",
    );
    // The attacker may remove the junk it added itself.
    await junk(1);
    await id
      .connect(attacker)
      .removeClaim(
        idSideId(attacker.address, KYC, ethers.toUtf8Bytes("junk0")),
      );
  });

  it("a self-added claim naming the attacker (or the trusted issuer) never verifies", async function () {
    await junk(3);
    await id
      .connect(attacker)
      .addClaim(KYC, 1, attacker.address, "0x", DATA, "");
    await id.connect(victim).addClaim(KYC, 1, kycAddr, "0x", DATA, "");
    expect(await ir.isVerified(victim.address)).to.equal(false);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
  });

  it("ClaimIssuer.hasValidClaim: newest first, expiry and revocation", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await issue(ethers.toUtf8Bytes("old"), now + 100);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(true);
    expect(await kyc.hasValidClaim(idAddr, 7)).to.equal(false);
    await ethers.provider.send("evm_increaseTime", [200]);
    await ethers.provider.send("evm_mine", []);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
    // A renewal is the newest entry and verifies again.
    await issue(ethers.toUtf8Bytes("renewed"));
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(true);
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });
});
