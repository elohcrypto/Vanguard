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
      const sig = await signClaim(issuerOwner, idAddr, KYC, d, { uri: "u" });
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

  describe("L-D: the signature covers scheme, uri and validTo (Q5)", function () {
    const d = ethers.toUtf8Bytes("KYC_OK");
    const signed = { scheme: 1, uri: "ipfs://a", validTo: 4102444800 };
    const edits: [string, Record<string, unknown>][] = [
      ["validTo", { validTo: 4102444801 }],
      ["uri", { uri: "ipfs://b" }],
      ["scheme", { scheme: 2 }],
    ];

    it("the signers' digest is ClaimIssuer.claimDigest", async function () {
      const { kyc, idAddr } = await setup();
      const local = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256", "uint256", "bytes", "string", "uint256"],
          [idAddr, KYC, 1, d, "ipfs://a", 4102444800],
        ),
      );
      expect(
        await kyc.claimDigest(idAddr, KYC, 1, d, "ipfs://a", 4102444800),
      ).to.equal(local);
      // data and uri cannot trade bytes (abi.encode, not encodePacked).
      expect(
        await kyc.claimDigest(idAddr, KYC, 1, "0x6162", "c", 0),
      ).to.not.equal(await kyc.claimDigest(idAddr, KYC, 1, "0x61", "bc", 0));
    });

    for (const [field, edit] of edits) {
      it(`a claim with an edited ${field} is refused on every path`, async function () {
        const { issuerOwner, kyc, idAddr } = await setup();
        const sig = await signClaim(issuerOwner, idAddr, KYC, d, signed);
        const f = { ...signed, ...edit } as typeof signed;
        const args = [f.scheme, d, f.uri, f.validTo] as const;
        const msg = "ClaimIssuer: Signer does not have claim signer key";
        await expect(
          kyc.connect(issuerOwner).issueClaim(idAddr, KYC, ...args, sig),
        ).to.be.revertedWith(msg);
        await expect(
          kyc
            .connect(issuerOwner)
            .batchIssueClaims(
              [idAddr],
              [KYC],
              [f.scheme],
              [d],
              [f.uri],
              [f.validTo],
              [sig],
            ),
        ).to.be.revertedWith(msg);
        expect(await kyc.verifyClaim(idAddr, KYC, ...args, sig)).to.equal(
          false,
        );
        // The signed fields verify and issue.
        const ok = [signed.scheme, d, signed.uri, signed.validTo] as const;
        expect(await kyc.verifyClaim(idAddr, KYC, ...ok, sig)).to.equal(true);
        await kyc.connect(issuerOwner).issueClaim(idAddr, KYC, ...ok, sig);
        expect(await kyc.claimValidTo(idAddr, KYC)).to.equal(signed.validTo);
      });
    }
  });

  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  describe("N-4: deployOnchainIDWithKey adds the key", function () {
    it("a factory identity holds the given management key", async function () {
      const [owner, holder, stranger] = await ethers.getSigners();
      const fac = await (
        await ethers.getContractFactory("OnchainIDFactory")
      ).deploy(owner.address, ethers.ZeroHash);
      const key = keyOf(stranger.address);
      const salt = ethers.id("n4");
      await fac.deployOnchainIDWithKey(holder.address, key, salt);
      const id = await ethers.getContractAt(
        "OnchainID",
        await fac.saltToIdentity(salt),
      );
      expect(await id.keyHasPurpose(key, 1)).to.equal(true);
      expect(await id.keyHasPurpose(keyOf(holder.address), 1)).to.equal(true);
      expect(await id.getKeysByPurpose(1)).to.have.length(2);
      // The owner's own key as the "extra" key is not a second entry.
      await fac.deployOnchainIDWithKey(
        stranger.address,
        keyOf(stranger.address),
        ethers.id("n4b"),
      );
      const id2 = await ethers.getContractAt(
        "OnchainID",
        await fac.saltToIdentity(ethers.id("n4b")),
      );
      expect(await id2.getKeysByPurpose(1)).to.have.length(1);
      // Only the creator, only in the creating block.
      await expect(
        id.connect(stranger).addCreationKey(ethers.id("k")),
      ).to.be.revertedWithCustomError(id, "NotCreator");
    });

    it("a direct deployer cannot add a creation key after its block", async function () {
      const [deployer, holder] = await ethers.getSigners();
      const id = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(holder.address);
      await expect(
        id.connect(deployer).addCreationKey(ethers.id("k")),
      ).to.be.revertedWithCustomError(id, "NotCreator");
    });
  });

  describe("N-5: only the deployer initializes", function () {
    it("a front-run initialize is refused; the deployer's goes through", async function () {
      const [deployer, holder, attacker] = await ethers.getSigners();
      const id = await (
        await ethers.getContractFactory("OnchainID")
      ).deploy(ethers.ZeroAddress);
      await expect(
        id
          .connect(attacker)
          .initialize(attacker.address, keyOf(attacker.address)),
      ).to.be.revertedWith("OnchainID: Only the deployer initializes");
      await id
        .connect(deployer)
        .initialize(holder.address, keyOf(holder.address));
      expect(await id.owner()).to.equal(holder.address);
    });
  });
});
