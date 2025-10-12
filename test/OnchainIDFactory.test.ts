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
        [owner, user1, user2, feeRecipient, unauthorized] = await ethers.getSigners();

        const OnchainIDFactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
        factory = await OnchainIDFactoryFactory.deploy(owner.address);
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
            const OnchainIDFactoryFactory = await ethers.getContractFactory("OnchainIDFactory");
            const newFactory = await OnchainIDFactoryFactory.deploy(user1.address);
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
        const salt = ethers.keccak256(ethers.solidityPacked(["string"], ["test-salt"]));

        it("Should deploy OnchainID with correct parameters", async function () {
            const tx = await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            });

            await expect(tx)
                .to.emit(factory, "OnchainIDDeployed")
                .withArgs(await factory.saltToIdentity(salt), user1.address, salt, user1.address);

            // Check that identity was registered
            expect(await factory.isOnchainID(await factory.saltToIdentity(salt))).to.be.true;
            expect(await factory.ownerToIdentity(user1.address)).to.equal(await factory.saltToIdentity(salt));
            expect(await factory.totalIdentities()).to.equal(1);
        });

        it("Should reject deployment with insufficient fee", async function () {
            const insufficientFee = ethers.parseEther("0.005");
            await expect(factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: insufficientFee
            })).to.be.revertedWith("OnchainIDFactory: Insufficient fee");
        });

        it("Should reject deployment with zero owner", async function () {
            await expect(factory.connect(user1).deployOnchainID(ethers.ZeroAddress, salt, {
                value: deploymentFee
            })).to.be.revertedWith("OnchainIDFactory: Invalid owner");
        });

        it("Should reject deployment with duplicate salt", async function () {
            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            });

            await expect(factory.connect(user2).deployOnchainID(user2.address, salt, {
                value: deploymentFee
            })).to.be.revertedWith("OnchainIDFactory: Salt already used");
        });

        it("Should reject deployment when paused", async function () {
            await factory.connect(owner).setDeploymentPaused(true);

            await expect(factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            })).to.be.revertedWith("OnchainIDFactory: Deployment is paused");
        });

        it("Should transfer fees to fee recipient", async function () {
            const initialBalance = await ethers.provider.getBalance(feeRecipient.address);

            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            });

            const finalBalance = await ethers.provider.getBalance(feeRecipient.address);
            expect(finalBalance - initialBalance).to.equal(deploymentFee);
        });
    });

    describe("deployOnchainIDWithKey", function () {
        const salt = ethers.keccak256(ethers.solidityPacked(["string"], ["test-salt-key"]));
        const managementKey = ethers.keccak256(ethers.solidityPacked(["string"], ["management-key"]));

        it("Should deploy OnchainID with custom management key", async function () {
            const tx = await factory.connect(user1).deployOnchainIDWithKey(
                user1.address, managementKey, salt, { value: deploymentFee }
            );

            await expect(tx)
                .to.emit(factory, "OnchainIDDeployed")
                .withArgs(await factory.saltToIdentity(salt), user1.address, salt, user1.address);

            // Verify the deployed identity exists and owner can add the management key
            const identityAddress = await factory.saltToIdentity(salt);
            const identity = await ethers.getContractAt("OnchainID", identityAddress);
            expect(await identity.owner()).to.equal(user1.address);

            // Owner can add the management key themselves
            await identity.connect(user1).addKey(managementKey, 1, 1);
            expect(await identity.keyHasPurpose(managementKey, 1)).to.be.true;
        });

        it("Should reject deployment with zero management key", async function () {
            await expect(factory.connect(user1).deployOnchainIDWithKey(
                user1.address, ethers.ZeroHash, salt, { value: deploymentFee }
            )).to.be.revertedWith("OnchainIDFactory: Invalid management key");
        });
    });

    describe("computeOnchainIDAddress", function () {
        it("Should compute correct address before deployment", async function () {
            const salt = ethers.keccak256(ethers.solidityPacked(["string"], ["compute-test"]));
            const computedAddress = await factory.computeOnchainIDAddress(user1.address, salt);

            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
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
                ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"]))
            ];
            const totalFee = deploymentFee * BigInt(2);

            const identities = await factory.connect(owner).batchDeployOnchainID.staticCall(
                owners, salts, { value: totalFee }
            );

            await factory.connect(owner).batchDeployOnchainID(owners, salts, {
                value: totalFee
            });

            expect(identities.length).to.equal(2);
            expect(await factory.totalIdentities()).to.equal(2);
            expect(await factory.ownerToIdentity(user1.address)).to.equal(identities[0]);
            expect(await factory.ownerToIdentity(user2.address)).to.equal(identities[1]);
        });

        it("Should reject batch with mismatched array lengths", async function () {
            const owners = [user1.address];
            const salts = [
                ethers.keccak256(ethers.solidityPacked(["string"], ["batch-1"])),
                ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"]))
            ];

            await expect(factory.connect(owner).batchDeployOnchainID(owners, salts, {
                value: deploymentFee
            })).to.be.revertedWith("OnchainIDFactory: Array length mismatch");
        });

        it("Should reject batch with insufficient fee", async function () {
            const owners = [user1.address, user2.address];
            const salts = [
                ethers.keccak256(ethers.solidityPacked(["string"], ["batch-1"])),
                ethers.keccak256(ethers.solidityPacked(["string"], ["batch-2"]))
            ];
            const insufficientFee = deploymentFee; // Should be 2x

            await expect(factory.connect(owner).batchDeployOnchainID(owners, salts, {
                value: insufficientFee
            })).to.be.revertedWith("OnchainIDFactory: Insufficient fee");
        });
    });

    describe("Query Functions", function () {
        let identityAddress: string;
        const salt = ethers.keccak256(ethers.solidityPacked(["string"], ["query-test"]));

        beforeEach(async function () {
            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            });
            identityAddress = await factory.saltToIdentity(salt);
        });

        describe("getIdentityByOwner", function () {
            it("Should return correct identity for owner", async function () {
                expect(await factory.getIdentityByOwner(user1.address)).to.equal(identityAddress);
            });

            it("Should return zero address for non-existent owner", async function () {
                expect(await factory.getIdentityByOwner(user2.address)).to.equal(ethers.ZeroAddress);
            });
        });

        describe("getIdentityBySalt", function () {
            it("Should return correct identity for salt", async function () {
                expect(await factory.getIdentityBySalt(salt)).to.equal(identityAddress);
            });

            it("Should return zero address for non-existent salt", async function () {
                const nonExistentSalt = ethers.keccak256(ethers.solidityPacked(["string"], ["non-existent"]));
                expect(await factory.getIdentityBySalt(nonExistentSalt)).to.equal(ethers.ZeroAddress);
            });
        });

        describe("getAllIdentities", function () {
            it("Should return all deployed identities", async function () {
                const allIdentities = await factory.getAllIdentities();
                expect(allIdentities.length).to.equal(1);
                expect(allIdentities[0]).to.equal(identityAddress);
            });
        });

        describe("getIdentitiesPaginated", function () {
            beforeEach(async function () {
                // Deploy more identities for pagination test
                const salt2 = ethers.keccak256(ethers.solidityPacked(["string"], ["pagination-2"]));
                const salt3 = ethers.keccak256(ethers.solidityPacked(["string"], ["pagination-3"]));

                await factory.connect(user2).deployOnchainID(user2.address, salt2, {
                    value: deploymentFee
                });
                await factory.connect(owner).deployOnchainID(owner.address, salt3, {
                    value: deploymentFee
                });
            });

            it("Should return paginated results", async function () {
                const page1 = await factory.getIdentitiesPaginated(0, 2);
                expect(page1.length).to.equal(2);

                const page2 = await factory.getIdentitiesPaginated(2, 2);
                expect(page2.length).to.equal(1);
            });

            it("Should handle offset beyond array length", async function () {
                await expect(factory.getIdentitiesPaginated(10, 2))
                    .to.be.revertedWith("OnchainIDFactory: Offset out of bounds");
            });
        });

        describe("isValidOnchainID", function () {
            it("Should return true for valid OnchainID", async function () {
                expect(await factory.isValidOnchainID(identityAddress)).to.be.true;
            });

            it("Should return false for invalid address", async function () {
                expect(await factory.isValidOnchainID(user1.address)).to.be.false;
            });
        });

        describe("getFactoryStats", function () {
            it("Should return correct factory statistics", async function () {
                const [totalDeployed, currentFee, isPaused] = await factory.getFactoryStats();
                expect(totalDeployed).to.equal(1);
                expect(currentFee).to.equal(deploymentFee);
                expect(isPaused).to.be.false;
            });
        });
    });

    describe("Admin Functions", function () {
        describe("setDeploymentFee", function () {
            it("Should allow owner to set deployment fee", async function () {
                const newFee = ethers.parseEther("0.02");
                await factory.connect(owner).setDeploymentFee(newFee);
                expect(await factory.deploymentFee()).to.equal(newFee);
            });

            it("Should reject fee setting by non-owner", async function () {
                const newFee = ethers.parseEther("0.02");
                await expect(factory.connect(unauthorized).setDeploymentFee(newFee))
                    .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            });
        });

        describe("setFeeRecipient", function () {
            it("Should allow owner to set fee recipient", async function () {
                await factory.connect(owner).setFeeRecipient(user1.address);
                expect(await factory.feeRecipient()).to.equal(user1.address);
            });

            it("Should reject zero address as fee recipient", async function () {
                await expect(factory.connect(owner).setFeeRecipient(ethers.ZeroAddress))
                    .to.be.revertedWith("OnchainIDFactory: Invalid recipient");
            });

            it("Should reject fee recipient setting by non-owner", async function () {
                await expect(factory.connect(unauthorized).setFeeRecipient(user1.address))
                    .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            });
        });

        describe("setDeploymentPaused", function () {
            it("Should allow owner to pause deployment", async function () {
                await factory.connect(owner).setDeploymentPaused(true);
                expect(await factory.deploymentPaused()).to.be.true;
            });

            it("Should allow owner to unpause deployment", async function () {
                await factory.connect(owner).setDeploymentPaused(true);
                await factory.connect(owner).setDeploymentPaused(false);
                expect(await factory.deploymentPaused()).to.be.false;
            });

            it("Should reject pause setting by non-owner", async function () {
                await expect(factory.connect(unauthorized).setDeploymentPaused(true))
                    .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            });
        });

        describe("emergencyWithdraw", function () {
            it("Should allow owner to withdraw contract balance", async function () {
                // Send some ether to the contract
                await user1.sendTransaction({
                    to: await factory.getAddress(),
                    value: ethers.parseEther("1.0")
                });

                const initialBalance = await ethers.provider.getBalance(owner.address);
                const tx = await factory.connect(owner).emergencyWithdraw();
                const receipt = await tx.wait();
                const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

                const finalBalance = await ethers.provider.getBalance(owner.address);
                expect(finalBalance - initialBalance + gasUsed).to.equal(ethers.parseEther("1.0"));
            });

            it("Should reject withdrawal when no balance", async function () {
                await expect(factory.connect(owner).emergencyWithdraw())
                    .to.be.revertedWith("OnchainIDFactory: No balance to withdraw");
            });

            it("Should reject withdrawal by non-owner", async function () {
                await expect(factory.connect(unauthorized).emergencyWithdraw())
                    .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
            });
        });

        describe("transferOwnership", function () {
            it("Should transfer ownership with custom event", async function () {
                await expect(factory.connect(owner).transferOwnership(user1.address))
                    .to.emit(factory, "FactoryOwnershipTransferred")
                    .withArgs(owner.address, user1.address);

                expect(await factory.owner()).to.equal(user1.address);
            });

            it("Should reject transfer to zero address", async function () {
                await expect(factory.connect(owner).transferOwnership(ethers.ZeroAddress))
                    .to.be.revertedWith("OnchainIDFactory: New owner is the zero address");
            });
        });
    });

    describe("Integration Tests", function () {
        it("Should deploy functional OnchainID contracts", async function () {
            const salt = ethers.keccak256(ethers.solidityPacked(["string"], ["integration-test"]));

            await factory.connect(user1).deployOnchainID(user1.address, salt, {
                value: deploymentFee
            });

            const identityAddress = await factory.saltToIdentity(salt);
            const identity = await ethers.getContractAt("OnchainID", identityAddress);

            // Test that the deployed contract is functional
            expect(await identity.owner()).to.equal(user1.address);
            expect(await identity.getCreationTime()).to.be.gt(0);

            // Test key management
            const testKey = ethers.keccak256(ethers.solidityPacked(["string"], ["test-key"]));
            await identity.connect(user1).addKey(testKey, 2, 1); // ACTION_KEY, ECDSA_TYPE
            expect(await identity.keyHasPurpose(testKey, 2)).to.be.true;
        });

        it("Should handle multiple deployments correctly", async function () {
            const deployments = [];
            for (let i = 0; i < 5; i++) {
                const salt = ethers.keccak256(ethers.solidityPacked(["uint256"], [i]));
                const owner = await ethers.getImpersonatedSigner(`0x${'1'.repeat(39)}${i}`);
                await user1.sendTransaction({ to: owner.address, value: ethers.parseEther("1") });

                await factory.connect(owner).deployOnchainID(owner.address, salt, {
                    value: deploymentFee
                });

                deployments.push(await factory.saltToIdentity(salt));
            }

            expect(await factory.totalIdentities()).to.equal(5);
            const allIdentities = await factory.getAllIdentities();
            expect(allIdentities.length).to.equal(5);

            for (const deployment of deployments) {
                expect(await factory.isValidOnchainID(deployment)).to.be.true;
            }
        });
    });
});