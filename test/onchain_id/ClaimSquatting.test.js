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

  // Review of 2F.2, F1: the issuer used to scan only the newest 8 claims of
  // an identity across ALL topics. It now keeps a pointer to its latest
  // claim per (identity, topic): the latest claim decides.
  const ACC = 9;
  const issuerId = (data, topic = KYC) =>
    ethers.solidityPackedKeccak256(
      ["address", "address", "uint256", "bytes"],
      [kycAddr, idAddr, topic, data],
    );
  async function issueOn(topic, data) {
    const d = ethers.toUtf8Bytes(data);
    const sig = await sign(issuerOwner, idAddr, topic, d);
    return kyc.connect(issuerOwner).issueClaim(idAddr, topic, 1, d, "", 0, sig);
  }

  it("claims on other topics never push KYC out (F1-A)", async function () {
    await ir.addTrustedIssuer(kycAddr, [ACC]);
    await issue();
    for (let i = 0; i < 9; i++) await issueOn(ACC, "acc-" + i);
    expect(await kyc.isClaimValid(issuerId(DATA))).to.equal(true);
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });

  it("re-issuing the same claim keeps the holder verified (F1-B)", async function () {
    await issue();
    for (let i = 0; i < 9; i++) await issue();
    for (let i = 0; i < 9; i++) await issueOn(ACC, "ACC_SAME");
    expect(await ir.isVerified(victim.address)).to.equal(true);
    expect(await kyc.latestClaimId(idAddr, KYC)).to.equal(issuerId(DATA));
  });

  it("revoking the latest claim unverifies even with an older live one (F1-C)", async function () {
    const y25 = ethers.toUtf8Bytes("KYC_2025");
    const y26 = ethers.toUtf8Bytes("KYC_2026");
    await issue(y25);
    await issue(y26);
    expect(await kyc.latestClaimId(idAddr, KYC)).to.equal(issuerId(y26));
    // Revoking a superseded claim has no effect.
    await kyc.connect(issuerOwner).revokeClaim(issuerId(y25));
    expect(await ir.isVerified(victim.address)).to.equal(true);
    await kyc.connect(issuerOwner).revokeClaim(issuerId(y26));
    expect(await kyc.isClaimValid(issuerId(y25))).to.equal(false);
    expect(await ir.isVerified(victim.address)).to.equal(false);

    const y25b = ethers.toUtf8Bytes("KYC_2025b");
    await issue(y25b);
    await kyc.connect(issuerOwner).revokeClaim(issuerId(y25b));
    // An older unrevoked claim does not come back.
    await issue(ethers.toUtf8Bytes("KYC_A"));
    await issue(ethers.toUtf8Bytes("KYC_B"));
    await kyc
      .connect(issuerOwner)
      .revokeClaim(issuerId(ethers.toUtf8Bytes("KYC_B")));
    expect(
      await kyc.isClaimValid(issuerId(ethers.toUtf8Bytes("KYC_A"))),
    ).to.equal(true);
    expect(await ir.isVerified(victim.address)).to.equal(false);
    // The issuer restores the holder by issuing a new claim.
    await issue(ethers.toUtf8Bytes("KYC_C"));
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });

  it("a renewal issued before expiry moves the pointer with no gap", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await issue(ethers.toUtf8Bytes("y1"), now + 1000);
    await issue(ethers.toUtf8Bytes("y2"), now + 5000);
    await ethers.provider.send("evm_increaseTime", [2000]);
    await ethers.provider.send("evm_mine", []);
    expect(await ir.isVerified(victim.address)).to.equal(true);
  });

  it("batch-issued claims verify and revoke by the same rule", async function () {
    const mk = async (s) => {
      const d = ethers.toUtf8Bytes(s);
      return [d, await sign(issuerOwner, idAddr, KYC, d)];
    };
    const [d1, s1] = await mk("B1");
    const [d2, s2] = await mk("B2");
    await kyc
      .connect(issuerOwner)
      .batchIssueClaims(
        [idAddr, idAddr],
        [KYC, KYC],
        [1, 1],
        [d1, d2],
        ["", ""],
        [0, 0],
        [s1, s2],
      );
    expect(await kyc.latestClaimId(idAddr, KYC)).to.equal(issuerId(d2));
    expect(await ir.isVerified(victim.address)).to.equal(true);
    await kyc.connect(issuerOwner).revokeClaim(issuerId(d1));
    expect(await ir.isVerified(victim.address)).to.equal(true);
    await expect(kyc.connect(issuerOwner).revokeClaim(issuerId(d2))).to.emit(
      kyc,
      "ClaimRemovalFailed",
    );
    expect(await ir.isVerified(victim.address)).to.equal(false);
  });

  // F5: an issuer that returns empty data or reverts must not make
  // isVerified revert; it counts as "no claim".
  async function rawContract(runtimeInitcode) {
    const tx = await issuerOwner.sendTransaction({ data: runtimeInitcode });
    return (await tx.wait()).contractAddress;
  }
  for (const [name, code] of [
    ["returns empty data (STOP)", "0x6001600c60003960016000f300"],
    ["reverts", "0x6005600c60003960056000f360006000fd"],
  ]) {
    it(`a trusted issuer that ${name} ahead of the real one is skipped (F5)`, async function () {
      await issue();
      const bad = await rawContract(code);
      const ir2 = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      await ir2.addClaimTopic(KYC);
      await ir2.addTrustedIssuer(bad, [KYC]);
      await ir2.addTrustedIssuer(kycAddr, [KYC]);
      await ir2.registerIdentity(victim.address, idAddr, 840);
      expect(await ir2.isVerified(victim.address)).to.equal(true);
      await ir2.removeTrustedIssuer(kycAddr);
      expect(await ir2.isVerified(victim.address)).to.equal(false);
    });
  }

  it("an identity address with no code is unverified even with an issuer claim (M20)", async function () {
    const eoaId = attacker.address;
    const d = ethers.toUtf8Bytes("EOA");
    await kyc
      .connect(issuerOwner)
      .batchIssueClaims(
        [eoaId],
        [KYC],
        [1],
        [d],
        [""],
        [0],
        [await sign(issuerOwner, eoaId, KYC, d)],
      );
    expect(await kyc.hasValidClaim(eoaId, KYC)).to.equal(true);
    await ir.registerIdentity(attacker.address, eoaId, 840);
    expect(await ir.isVerified(attacker.address)).to.equal(false);
  });

  // N1: the identity's own views ask the issuer too.
  it("OnchainID.hasValidClaim and isCompliant ask the issuer (N1)", async function () {
    await id.connect(victim).addTrustedIssuer(kycAddr, [KYC]);
    await id.connect(victim).addClaimTopic(KYC, true);
    // Owner forges a claim naming the trusted issuer.
    await id.connect(victim).addClaim(KYC, 1, kycAddr, "0x", DATA, "");
    expect(await id.hasValidClaim(KYC, kycAddr)).to.equal(false);
    expect(await id.isCompliant()).to.equal(false);
    let st = await id.getComplianceStatus();
    expect(st.valid).to.equal(false);
    expect(st.missingTopics.map(Number)).to.deep.equal([KYC]);
    // A real issuer claim verifies.
    await issue();
    expect(await id.hasValidClaim(KYC, kycAddr)).to.equal(true);
    expect(await id.isCompliant()).to.equal(true);
    st = await id.getComplianceStatus();
    expect(st.valid).to.equal(true);
    // No code at the issuer address: false, no revert.
    expect(await id.hasValidClaim(KYC, attacker.address)).to.equal(false);
  });

  // N2: only the issuer may update its own identity-side copy.
  it("the owner cannot overwrite the issuer's identity-side copy (N2)", async function () {
    await issue();
    const side = idSideId(kycAddr, KYC, DATA);
    await expect(
      id.connect(victim).addClaim(KYC, 1, kycAddr, "0xdead", DATA, "evil-uri"),
    ).to.be.revertedWith("OnchainID: Only the issuer updates its claim");
    const c = await id.getClaim(side);
    expect(c.uri).to.equal("");
    expect(c.signature).to.not.equal("0xdead");
    // The issuer itself still re-issues in place; the owner may remove.
    await issue();
    await id.connect(victim).removeClaim(side);
  });

  // M22: _swapPop must re-index the element it moves.
  it("removing a swapped-in claim keeps both lists consistent (M22)", async function () {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const d = ethers.toUtf8Bytes("c" + i);
      await id.connect(victim).addClaim(5, 1, victim.address, "0x", d, "");
      ids.push(idSideId(victim.address, 5, d));
    }
    await id.connect(victim).removeClaim(ids[0]); // c3 moves to slot 0
    await id.connect(victim).removeClaim(ids[3]); // the moved element
    expect([...(await id.getClaimIdsByTopic(5))]).to.have.members([
      ids[1],
      ids[2],
    ]);
    expect([...(await id.getAllClaims())]).to.have.members([ids[1], ids[2]]);
    await id.connect(victim).removeClaim(ids[2]);
    await id.connect(victim).removeClaim(ids[1]);
    expect((await id.getAllClaims()).length).to.equal(0);
    await id
      .connect(victim)
      .addClaim(5, 1, victim.address, "0x", ethers.toUtf8Bytes("c0"), "");
    await id.connect(victim).removeClaim(ids[0]);
    expect((await id.getAllClaims()).length).to.equal(0);
    expect((await id.getClaimIdsByTopic(5)).length).to.equal(0);
  });
});
