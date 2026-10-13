import { expect } from "chai";
import { ethers } from "hardhat";
import { signClaim } from "../helpers/kyc";

// Task 5.2 review L-2: a revoked claim never comes back through any
// signature made before the revocation. revokeClaim bumps the (identity,
// topic)'s revocationEpoch, which every claim signature covers.
const KYC = 6;
const T1 = 4102444800;

describe("Revocation epoch (Task 5.2, review L-2)", function () {
  async function setup() {
    const [, issuerOwner, holder] = await ethers.getSigners();
    const kyc = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(issuerOwner.address, "KYC", "kyc");
    const idAddr = await (
      await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(holder.address)
    ).getAddress();
    const sign = (data: Uint8Array, validTo = 0) =>
      signClaim(issuerOwner, kyc, idAddr, KYC, data, { validTo });
    const issue = (data: Uint8Array, sig: string, validTo = 0) =>
      kyc
        .connect(issuerOwner)
        .issueClaim(idAddr, KYC, 1, data, "", validTo, sig);
    const revokeLatest = async () =>
      kyc
        .connect(issuerOwner)
        .revokeClaim(await kyc.latestClaimId(idAddr, KYC));
    return { issuerOwner, kyc, idAddr, sign, issue, revokeLatest };
  }
  const refused = "ClaimIssuer: Signer does not have claim signer key";
  const D = ethers.toUtf8Bytes("KYC_OK");

  it("L-2 a: a renewal's older signature is refused after the renewal is revoked", async function () {
    const { kyc, idAddr, sign, issue, revokeLatest } = await setup();
    const s1 = await sign(D, T1);
    await issue(D, s1, T1);
    const s2 = await sign(D, T1 + 1000); // the renewal, same claimId
    await issue(D, s2, T1 + 1000);
    await revokeLatest();
    expect(await kyc.revocationEpoch(idAddr, KYC)).to.equal(1n);
    await expect(issue(D, s1, T1)).to.be.revertedWith(refused);
    await expect(issue(D, s2, T1 + 1000)).to.be.revertedWith(refused);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
  });

  it("L-2 b: an older claim's signature on the same (identity, topic) is refused", async function () {
    const { kyc, idAddr, sign, issue, revokeLatest } = await setup();
    const d1 = ethers.toUtf8Bytes("data1");
    const d2 = ethers.toUtf8Bytes("data2");
    const sig1 = await sign(d1);
    await issue(d1, sig1);
    await issue(d2, await sign(d2));
    const latest = await kyc.latestClaimId(idAddr, KYC);
    await revokeLatest();
    await expect(issue(d1, sig1)).to.be.revertedWith(refused);
    expect(await kyc.latestClaimId(idAddr, KYC)).to.equal(latest);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
  });

  it("a pre-revocation signature is refused by issueClaim, batchIssueClaims and verifyClaim", async function () {
    const { issuerOwner, kyc, idAddr, sign, issue, revokeLatest } =
      await setup();
    await issue(D, await sign(D));
    const old = await sign(ethers.toUtf8Bytes("other"));
    const o = ethers.toUtf8Bytes("other");
    expect(await kyc.verifyClaim(idAddr, KYC, 1, o, "", 0, old)).to.equal(true);
    await revokeLatest();
    await expect(issue(o, old)).to.be.revertedWith(refused);
    await expect(
      kyc
        .connect(issuerOwner)
        .batchIssueClaims([idAddr], [KYC], [1], [o], [""], [0], [old]),
    ).to.be.revertedWith(refused);
    expect(await kyc.verifyClaim(idAddr, KYC, 1, o, "", 0, old)).to.equal(
      false,
    );
    // Signed for the old epoch explicitly: the same answer.
    const ep0 = await signClaim(issuerOwner, kyc, idAddr, KYC, o, { epoch: 0 });
    expect(ep0).to.equal(old);
  });

  it("a renewal with identical fields after revocation issues (new epoch)", async function () {
    const { kyc, idAddr, sign, issue, revokeLatest } = await setup();
    const s0 = await sign(D);
    await issue(D, s0);
    await revokeLatest();
    const s1 = await sign(D); // same fields, epoch 1
    expect(s1).to.not.equal(s0);
    await issue(D, s1);
    expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(true);
    // Another topic is untouched by the bump.
    expect(await kyc.revocationEpoch(idAddr, 7)).to.equal(0n);
  });
});
