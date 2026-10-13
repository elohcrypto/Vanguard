import { expect } from "chai";
import { ethers } from "hardhat";
import { signClaim } from "../helpers/kyc";

// Plan v2 Task 5.2: what the issuer signs is what the registry relies on.
const KYC = 6;

describe("Issuer and identity carry-overs (Task 5.2)", function () {
  async function setup() {
    const [, issuerOwner, holder, stranger] = await ethers.getSigners();
    const kyc = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(issuerOwner.address, "KYC", "kyc");
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(holder.address);
    const idAddr = await id.getAddress();
    const kycAddr = await kyc.getAddress();
    return { issuerOwner, holder, stranger, kyc, kycAddr, id, idAddr };
  }

  const sideId = (issuer: string, data: Uint8Array) =>
    ethers.solidityPackedKeccak256(
      ["address", "uint256", "bytes"],
      [issuer, KYC, data],
    );

  describe("L-C: batchIssueClaims goes through issueClaim's path", function () {
    it("a batch-issued claim is on the identity", async function () {
      const { issuerOwner, kyc, kycAddr, id, idAddr } = await setup();
      const d = ethers.toUtf8Bytes("B1");
      const sig = await signClaim(issuerOwner, idAddr, KYC, d);
      await kyc
        .connect(issuerOwner)
        .batchIssueClaims([idAddr], [KYC], [1], [d], ["u"], [0], [sig]);
      const c = await id.getClaim(sideId(kycAddr, d));
      expect(c.issuer).to.equal(kycAddr);
      expect(c.data).to.equal(ethers.hexlify(d));
      expect(await id.getClaimIdsByTopic(KYC)).to.deep.equal([
        sideId(kycAddr, d),
      ]);
      expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(true);
    });

    it("a batch is refused whole when one identity refuses addClaim", async function () {
      const { issuerOwner, kyc, idAddr } = await setup();
      const bad = await (
        await ethers.getContractFactory("MockTarget")
      ).deploy();
      const badAddr = await bad.getAddress();
      const d = ethers.toUtf8Bytes("B2");
      const sigs = [
        await signClaim(issuerOwner, idAddr, KYC, d),
        await signClaim(issuerOwner, badAddr, KYC, d),
      ];
      await expect(
        kyc
          .connect(issuerOwner)
          .batchIssueClaims(
            [idAddr, badAddr],
            [KYC, KYC],
            [1, 1],
            [d, d],
            ["", ""],
            [0, 0],
            sigs,
          ),
      ).to.be.revertedWith("ClaimIssuer: Failed to add claim to OnchainID");
      expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
      expect(await kyc.hasValidClaim(badAddr, KYC)).to.equal(false);
      expect(await kyc.latestClaimId(badAddr, KYC)).to.equal(ethers.ZeroHash);
      expect((await kyc.getIssuerStats()).totalClaims).to.equal(0n);
    });
  });
});
