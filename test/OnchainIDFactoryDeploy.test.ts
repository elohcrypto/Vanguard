import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OnchainIDFactory, OnchainID } from "../typechain-types";

describe("OnchainIDFactory", function () {
  let factory: OnchainIDFactory;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  const deploymentFee = ethers.parseEther("0.01");

  beforeEach(async function () {
    [owner, user1, user2, feeRecipient, unauthorized] =
      await ethers.getSigners();

    const OnchainIDFactoryFactory =
      await ethers.getContractFactory("OnchainIDFactory");
    factory = await OnchainIDFactoryFactory.deploy(
      owner.address,
      ethers.ZeroHash,
    );
    await factory.waitForDeployment();

    // Set deployment fee and fee recipient
    await factory.connect(owner).setDeploymentFee(deploymentFee);
    await factory.connect(owner).setFeeRecipient(feeRecipient.address);
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await factory.owner()).to.equal(owner.address);
    });

    it("Should set initial fee recipient to owner", async function () {
      const OnchainIDFactoryFactory =
        await ethers.getContractFactory("OnchainIDFactory");
      const newFactory = await OnchainIDFactoryFactory.deploy(
        user1.address,
        ethers.ZeroHash,
      );
      expect(await newFactory.feeRecipient()).to.equal(user1.address);
    });

    it("Should initialize with zero total identities", async function () {
      expect(await factory.totalIdentities()).to.equal(0);
    });

    it("Should not be paused initially", async function () {
      expect(await factory.deploymentPaused()).to.be.false;
    });
  });

  describe("deployOnchainID", function () {
    const salt = ethers.keccak256(
      ethers.solidityPacked(["string"], ["test-salt"]),
    );

    it("Should deploy OnchainID with correct parameters", async function () {
      const tx = await factory
        .connect(user1)
        .deployOnchainID(user1.address, salt, {
          value: deploymentFee,
        });

      await expect(tx)
        .to.emit(factory, "OnchainIDDeployed")
        .withArgs(
          await factory.saltToIdentity(salt),
          user1.address,
          salt,
          user1.address,
        );

      // Check that identity was registered
      expect(await factory.isOnchainID(await factory.saltToIdentity(salt))).to
        .be.true;
      expect(await factory.ownerToIdentity(user1.address)).to.equal(
        await factory.saltToIdentity(salt),
      );
      expect(await factory.totalIdentities()).to.equal(1);
    });

    it("Should reject deployment with insufficient fee", async function () {
      const insufficientFee = ethers.parseEther("0.005");
      await expect(
        factory.connect(user1).deployOnchainID(user1.address, salt, {
          value: insufficientFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Insufficient fee");
    });

    it("Should reject deployment with zero owner", async function () {
      await expect(
        factory.connect(user1).deployOnchainID(ethers.ZeroAddress, salt, {
          value: deploymentFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Invalid owner");
    });

    it("Should reject deployment with duplicate salt", async function () {
      await factory.connect(user1).deployOnchainID(user1.address, salt, {
        value: deploymentFee,
      });

      await expect(
        factory.connect(user2).deployOnchainID(user2.address, salt, {
          value: deploymentFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Salt already used");
    });

    it("Should reject deployment when paused", async function () {
      await factory.connect(owner).setDeploymentPaused(true);

      await expect(
        factory.connect(user1).deployOnchainID(user1.address, salt, {
          value: deploymentFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Deployment is paused");
    });

    it("Should transfer fees to fee recipient", async function () {
      const initialBalance = await ethers.provider.getBalance(
        feeRecipient.address,
      );

      await factory.connect(user1).deployOnchainID(user1.address, salt, {
        value: deploymentFee,
      });

      const finalBalance = await ethers.provider.getBalance(
        feeRecipient.address,
      );
      expect(finalBalance - initialBalance).to.equal(deploymentFee);
    });
  });

  describe("deployOnchainIDWithKey", function () {
    const salt = ethers.keccak256(
      ethers.solidityPacked(["string"], ["test-salt-key"]),
    );
    const managementKey = ethers.keccak256(
      ethers.solidityPacked(["string"], ["management-key"]),
    );

    it("Should deploy OnchainID with custom management key", async function () {
      const tx = await factory
        .connect(user1)
        .deployOnchainIDWithKey(user1.address, managementKey, salt, {
          value: deploymentFee,
        });

      await expect(tx)
        .to.emit(factory, "OnchainIDDeployed")
        .withArgs(
          await factory.saltToIdentity(salt),
          user1.address,
          salt,
          user1.address,
        );

      // N-4 (Task 5.2): the factory added the key.
      const identityAddress = await factory.saltToIdentity(salt);
      const identity = await ethers.getContractAt("OnchainID", identityAddress);
      expect(await identity.owner()).to.equal(user1.address);
      expect(await identity.keyHasPurpose(managementKey, 1)).to.be.true;
    });

    it("Should reject deployment with zero management key", async function () {
      await expect(
        factory
          .connect(user1)
          .deployOnchainIDWithKey(user1.address, ethers.ZeroHash, salt, {
            value: deploymentFee,
          }),
      ).to.be.revertedWith("OnchainIDFactory: Invalid management key");
    });
  });

  describe("computeOnchainIDAddress", function () {
    it("Should compute correct address before deployment", async function () {
      const salt = ethers.keccak256(
        ethers.solidityPacked(["string"], ["compute-test"]),
      );
      const computedAddress = await factory.computeOnchainIDAddress(
        user1.address,
        salt,
      );

      await factory.connect(user1).deployOnchainID(user1.address, salt, {
        value: deploymentFee,
      });

      const actualAddress = await factory.saltToIdentity(salt);
      expect(computedAddress).to.equal(actualAddress);
    });
  });

  describe("batchDeployOnchainID", function () {
    it("Should deploy multiple identities in batch", async function () {
      const owners = [user1.address, user2.address];
      const salts = [
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-1"])),
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"])),
      ];
      const totalFee = deploymentFee * BigInt(2);

      const identities = await factory
        .connect(owner)
        .batchDeployOnchainID.staticCall(owners, salts, { value: totalFee });

      await factory.connect(owner).batchDeployOnchainID(owners, salts, {
        value: totalFee,
      });

      expect(identities.length).to.equal(2);
      expect(await factory.totalIdentities()).to.equal(2);
      expect(await factory.ownerToIdentity(user1.address)).to.equal(
        identities[0],
      );
      expect(await factory.ownerToIdentity(user2.address)).to.equal(
        identities[1],
      );
    });

    it("Should reject batch with mismatched array lengths", async function () {
      const owners = [user1.address];
      const salts = [
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-1"])),
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"])),
      ];

      await expect(
        factory.connect(owner).batchDeployOnchainID(owners, salts, {
          value: deploymentFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Array length mismatch");
    });

    it("Should reject batch with insufficient fee", async function () {
      const owners = [user1.address, user2.address];
      const salts = [
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-1"])),
        ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"])),
      ];
      const insufficientFee = deploymentFee; // Should be 2x

      await expect(
        factory.connect(owner).batchDeployOnchainID(owners, salts, {
          value: insufficientFee,
        }),
      ).to.be.revertedWith("OnchainIDFactory: Insufficient fee");
    });
  });
});
