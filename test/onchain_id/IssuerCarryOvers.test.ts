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
      const sig = await signClaim(issuerOwner, kyc, idAddr, KYC, d, {
        uri: "u",
      });
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
        await signClaim(issuerOwner, kyc, idAddr, KYC, d),
        await signClaim(issuerOwner, kyc, badAddr, KYC, d),
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
      const { kyc, kycAddr, idAddr } = await setup();
      const { chainId } = await ethers.provider.getNetwork();
      const local = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          [
            "uint256",
            "address",
            "address",
            "uint256",
            "uint256",
            "bytes",
            "string",
            "uint256",
          ],
          [chainId, kycAddr, idAddr, KYC, 1, d, "ipfs://a", 4102444800],
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
        const sig = await signClaim(issuerOwner, kyc, idAddr, KYC, d, signed);
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
    it("a factory identity holds the key its owner named", async function () {
      const [owner, holder, stranger] = await ethers.getSigners();
      const fac = await (
        await ethers.getContractFactory("OnchainIDFactory")
      ).deploy(owner.address, ethers.ZeroHash);
      // The holder names a second wallet of its own (here: stranger's).
      const key = keyOf(stranger.address);
      const salt = ethers.id("n4");
      await fac
        .connect(holder)
        .deployOnchainIDWithKey(holder.address, key, salt);
      const id = await ethers.getContractAt(
        "OnchainID",
        await fac.saltToIdentity(salt),
      );
      expect(await id.keyHasPurpose(key, 1)).to.equal(true);
      expect(await id.keyHasPurpose(keyOf(holder.address), 1)).to.equal(true);
      expect(await id.getKeysByPurpose(1)).to.have.length(2);
      // The owner's own key as the "extra" key is not a second entry.
      await fac
        .connect(stranger)
        .deployOnchainIDWithKey(
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

    it("M-1: only the owner names a key; the front-run (P1) fails", async function () {
      const [owner, victim, attacker] = await ethers.getSigners();
      const fac = await (
        await ethers.getContractFactory("OnchainIDFactory")
      ).deploy(owner.address, ethers.ZeroHash);
      const salt = ethers.id("victim-salt");
      const predicted = await fac.computeOnchainIDAddress(victim.address, salt);
      // Neither a stranger nor the factory owner installs a key on an
      // identity owned by someone else.
      for (const who of [attacker, owner]) {
        await expect(
          fac
            .connect(who)
            .deployOnchainIDWithKey(
              victim.address,
              keyOf(attacker.address),
              salt,
            ),
        ).to.be.revertedWithCustomError(fac, "OnlyOwnerNamesKey");
      }
      // The victim's own deploy lands at its predicted address, with its
      // key only.
      await fac.connect(victim).deployOnchainID(victim.address, salt);
      expect(await fac.saltToIdentity(salt)).to.equal(predicted);
      const id = await ethers.getContractAt("OnchainID", predicted);
      expect(await id.keyHasPurpose(keyOf(attacker.address), 1)).to.equal(
        false,
      );
      expect(await id.getKeysByPurpose(1)).to.deep.equal([
        keyOf(victim.address),
      ]);
    });

    it("a stranger in the creating block cannot add a creation key", async function () {
      const [owner, holder, stranger] = await ethers.getSigners();
      const fac = await (
        await ethers.getContractFactory("OnchainIDFactory")
      ).deploy(owner.address, ethers.ZeroHash);
      const salt = ethers.id("same-block");
      const at = await fac.computeOnchainIDAddress(holder.address, salt);
      const id = await ethers.getContractAt("OnchainID", at);
      const key = ethers.id("stranger-key");
      await ethers.provider.send("evm_setAutomine", [false]);
      try {
        // Estimated now: the deploy does not depend on the pending block.
        const dep = await fac.deployOnchainID(holder.address, salt);
        const tx = await id
          .connect(stranger)
          .addCreationKey(key, { gasLimit: 2e5 });
        await ethers.provider.send("evm_mine", []);
        const rc = await ethers.provider.getTransactionReceipt(tx.hash);
        const depRc = await ethers.provider.getTransactionReceipt(dep.hash);
        expect(depRc!.status).to.equal(1);
        expect(rc!.status).to.equal(0);
        expect(rc!.blockNumber).to.equal(depRc!.blockNumber);
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
      expect(await id.owner()).to.equal(holder.address);
      expect(await id.keyHasPurpose(key, 1)).to.equal(false);
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
      ).to.be.revertedWithCustomError(id, "NotCreator");
      await id
        .connect(deployer)
        .initialize(holder.address, keyOf(holder.address));
      expect(await id.owner()).to.equal(holder.address);
    });
  });

  describe("N-6: one rule for both claim adders", function () {
    const args = (issuer: string) =>
      [KYC, 1, issuer, "0x", ethers.toUtf8Bytes("x"), ""] as const;
    const batch = (issuer: string) =>
      [[KYC], [1], [issuer], ["0x"], [ethers.toUtf8Bytes("x")], [""]] as [
        number[],
        number[],
        string[],
        string[],
        Uint8Array[],
        string[],
      ];

    it("an authorized manager adds by both paths; a stranger by neither", async function () {
      const { holder, stranger, id, kycAddr } = await setup();
      const [manager] = await ethers.getSigners();
      const msg = "OnchainID: Not authorized to add claim";
      await expect(
        id.connect(stranger).addClaim(...args(kycAddr)),
      ).to.be.revertedWith(msg);
      await expect(
        id.connect(stranger).batchAddClaims(...batch(kycAddr)),
      ).to.be.revertedWith(msg);
      await id.connect(holder).authorizeManager(manager.address);
      await id.connect(manager).addClaim(...args(kycAddr));
      await id
        .connect(manager)
        .batchAddClaims(...batch(ethers.Wallet.createRandom().address));
      expect(await id.getClaimIdsByTopic(KYC)).to.have.length(2);
      // A de-authorized manager loses both.
      await id.connect(holder).deauthorizeManager(manager.address);
      await expect(
        id.connect(manager).addClaim(...args(holder.address)),
      ).to.be.revertedWith(msg);
      await expect(
        id.connect(manager).batchAddClaims(...batch(holder.address)),
      ).to.be.revertedWith(msg);
    });
  });

  describe("L-1: a signature is bound to one issuer on one chain", function () {
    const d = ethers.toUtf8Bytes("KYC_OK");
    it("a signature made for issuer A is refused at issuer B", async function () {
      const [, ownerA, ownerB, holder, k] = await ethers.getSigners();
      const CI = await ethers.getContractFactory("ClaimIssuer");
      const A = await CI.deploy(ownerA.address, "A", "a");
      const B = await CI.deploy(ownerB.address, "B", "b");
      await A.connect(ownerA).addIssuerKey(keyOf(k.address), 3, 1);
      await B.connect(ownerB).addIssuerKey(keyOf(k.address), 3, 1);
      const idAddr = await (
        await (
          await ethers.getContractFactory("OnchainID")
        ).deploy(holder.address)
      ).getAddress();
      const sig = await signClaim(k, A, idAddr, KYC, d);
      await A.connect(k).issueClaim(idAddr, KYC, 1, d, "", 0, sig);
      await expect(
        B.connect(k).issueClaim(idAddr, KYC, 1, d, "", 0, sig),
      ).to.be.revertedWith(
        "ClaimIssuer: Signer does not have claim signer key",
      );
      expect(await B.verifyClaim(idAddr, KYC, 1, d, "", 0, sig)).to.equal(
        false,
      );
      expect(await A.hasValidClaim(idAddr, KYC)).to.equal(true);
      expect(await B.hasValidClaim(idAddr, KYC)).to.equal(false);
    });

    it("a signature made for another chain id is refused", async function () {
      // The chain is varied in the signed digest: the same issuer, fields
      // and key, signed for chain 1; this chain is hardhat's 31337.
      const { issuerOwner, kyc, idAddr } = await setup();
      const { chainId } = await ethers.provider.getNetwork();
      expect(chainId).to.not.equal(1n);
      const other = await signClaim(issuerOwner, kyc, idAddr, KYC, d, {
        chainId: 1,
      });
      await expect(
        kyc.connect(issuerOwner).issueClaim(idAddr, KYC, 1, d, "", 0, other),
      ).to.be.revertedWith(
        "ClaimIssuer: Signer does not have claim signer key",
      );
      expect(await kyc.verifyClaim(idAddr, KYC, 1, d, "", 0, other)).to.equal(
        false,
      );
      const here = await signClaim(issuerOwner, kyc, idAddr, KYC, d, {
        chainId,
      });
      await kyc.connect(issuerOwner).issueClaim(idAddr, KYC, 1, d, "", 0, here);
    });
  });

  describe("a revoked claim's signature never issues again", function () {
    it("resubmitting it is refused; a new signature over new fields issues", async function () {
      const { issuerOwner, kyc, idAddr } = await setup();
      const d = ethers.toUtf8Bytes("KYC_OK");
      const sig = await signClaim(issuerOwner, kyc, idAddr, KYC, d);
      await kyc.connect(issuerOwner).issueClaim(idAddr, KYC, 1, d, "", 0, sig);
      await kyc
        .connect(issuerOwner)
        .revokeClaim(await kyc.latestClaimId(idAddr, KYC));
      expect(await kyc.revokedSignature(ethers.keccak256(sig))).to.equal(true);
      await expect(
        kyc.connect(issuerOwner).issueClaim(idAddr, KYC, 1, d, "", 0, sig),
      ).to.be.revertedWithCustomError(kyc, "SignatureRevoked");
      await expect(
        kyc
          .connect(issuerOwner)
          .batchIssueClaims([idAddr], [KYC], [1], [d], [""], [0], [sig]),
      ).to.be.revertedWithCustomError(kyc, "SignatureRevoked");
      expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(false);
      // A renewal: a fresh signature over a later validTo.
      const validTo = 4102444800;
      const fresh = await signClaim(issuerOwner, kyc, idAddr, KYC, d, {
        validTo,
      });
      await kyc
        .connect(issuerOwner)
        .issueClaim(idAddr, KYC, 1, d, "", validTo, fresh);
      expect(await kyc.hasValidClaim(idAddr, KYC)).to.equal(true);
    });
  });
});
