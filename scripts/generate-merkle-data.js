const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Merkle Root and Nullifier Generator
 * Generates real merkle roots and nullifier hashes for whitelist membership
 */
class MerkleDataGenerator {
    constructor() {
        this.dataDir = path.join(__dirname, "../data");
        this.whitelistFile = path.join(this.dataDir, "whitelist-data.json");
        this.merkleFile = path.join(this.dataDir, "merkle-roots.json");
        
        // Ensure data directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Create a whitelist from Hardhat signers
     * @param {number} count - Number of addresses to include
     * @returns {string[]} Array of addresses
     */
    async createWhitelist(count = 10) {
        const signers = await ethers.getSigners();
        const addresses = signers.slice(0, count).map(signer => signer.address);
        
        console.log(`📋 Created whitelist with ${addresses.length} addresses:`);
        addresses.forEach((addr, i) => {
            console.log(`   ${i + 1}. ${addr}`);
        });
        
        return addresses;
    }

    /**
     * Build simple Merkle tree using keccak256
     * @param {string[]} addresses - Whitelist addresses
     * @returns {Object} Merkle tree data
     */
    buildMerkleTree(addresses) {
        console.log("🌳 Building Merkle tree...");
        
        // Convert addresses to leaf hashes
        let currentLevel = addresses.map(addr => {
            return ethers.keccak256(ethers.toUtf8Bytes(addr));
        });
        
        const tree = [currentLevel];
        const originalLeaves = [...currentLevel];
        
        // Pad to next power of 2
        const targetSize = Math.pow(2, Math.ceil(Math.log2(currentLevel.length)));
        while (currentLevel.length < targetSize) {
            currentLevel.push(ethers.ZeroHash);
        }
        
        // Build tree bottom-up
        while (currentLevel.length > 1) {
            const nextLevel = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1] || ethers.ZeroHash;
                const parent = ethers.keccak256(
                    ethers.solidityPacked(["bytes32", "bytes32"], [left, right])
                );
                nextLevel.push(parent);
            }
            currentLevel = nextLevel;
            tree.push(currentLevel);
        }
        
        const merkleRoot = currentLevel[0];
        
        console.log(`   🌳 Merkle Root: ${merkleRoot}`);
        console.log(`   📊 Tree Levels: ${tree.length}`);
        console.log(`   🍃 Leaf Count: ${originalLeaves.length}`);
        
        return {
            root: merkleRoot,
            leaves: originalLeaves,
            tree: tree,
            addresses: addresses
        };
    }

    /**
     * Generate nullifier hash for a specific user
     * @param {string} userAddress - User's address
     * @param {string} merkleRoot - Merkle root
     * @returns {string} Nullifier hash
     */
    generateNullifier(userAddress, merkleRoot) {
        // Create deterministic but unique nullifier
        const userIdentity = ethers.keccak256(ethers.toUtf8Bytes(userAddress));
        const nullifier = ethers.keccak256(
            ethers.solidityPacked(["bytes32", "bytes32"], [userIdentity, merkleRoot])
        );
        return nullifier;
    }

    /**
     * Generate simple numeric nullifier for demo use
     * @param {string} userAddress - User's address
     * @param {string} merkleRoot - Merkle root
     * @returns {number} Simple numeric nullifier
     */
    generateSimpleNullifier(userAddress, merkleRoot) {
        const fullNullifier = this.generateNullifier(userAddress, merkleRoot);
        // Convert to a simple number for demo use
        const numericNullifier = parseInt(fullNullifier.slice(2, 8), 16);
        return numericNullifier;
    }

    /**
     * Save whitelist and blacklist merkle data to files
     * @param {Object} data - Data to save
     */
    saveData(data) {
        // Handle both old format (single whitelist) and new format (whitelist + blacklist)
        if (data.whitelist && data.blacklist) {
            // New format with both whitelist and blacklist
            const completeData = {
                whitelist: {
                    addresses: data.whitelist.addresses,
                    merkleRoot: data.whitelist.merkleRoot,
                    nullifiers: data.whitelist.nullifiers,
                    simpleNullifiers: data.whitelist.simpleNullifiers,
                    leafCount: data.whitelist.addresses.length
                },
                blacklist: {
                    addresses: data.blacklist.addresses,
                    merkleRoot: data.blacklist.merkleRoot,
                    challengeHash: data.blacklist.challengeHash,
                    nullifiers: data.blacklist.nullifiers,
                    simpleNullifiers: data.blacklist.simpleNullifiers,
                    leafCount: data.blacklist.addresses.length
                },
                createdAt: new Date().toISOString()
            };

            fs.writeFileSync(this.whitelistFile, JSON.stringify(completeData, null, 2));
            console.log(`💾 Complete whitelist + blacklist data saved to: ${this.whitelistFile}`);

            // Save merkle roots for different scenarios
            const merkleData = {
                production: {
                    whitelist: {
                        root: data.whitelist.merkleRoot,
                        description: "Production whitelist merkle root",
                        addresses: data.whitelist.addresses
                    },
                    blacklist: {
                        root: data.blacklist.merkleRoot,
                        challengeHash: data.blacklist.challengeHash,
                        description: "Production blacklist merkle root",
                        addresses: data.blacklist.addresses
                    }
                },
                demo: {
                    whitelist: {
                        root: ethers.keccak256(ethers.toUtf8Bytes("demo_whitelist_root_" + Date.now())),
                        description: "Demo whitelist root for testing"
                    },
                    blacklist: {
                        root: ethers.keccak256(ethers.toUtf8Bytes("demo_blacklist_root_" + Date.now())),
                        challengeHash: ethers.keccak256(ethers.toUtf8Bytes("demo_challenge_" + Date.now())),
                        description: "Demo blacklist root for testing"
                    }
                },
                test: {
                    whitelist: {
                        root: ethers.keccak256(ethers.toUtf8Bytes("test_whitelist_root")),
                        description: "Test whitelist root for unit tests"
                    },
                    blacklist: {
                        root: ethers.keccak256(ethers.toUtf8Bytes("test_blacklist_root")),
                        challengeHash: ethers.keccak256(ethers.toUtf8Bytes("test_challenge")),
                        description: "Test blacklist root for unit tests"
                    }
                },
                createdAt: new Date().toISOString()
            };

            fs.writeFileSync(this.merkleFile, JSON.stringify(merkleData, null, 2));
            console.log(`💾 Complete merkle roots saved to: ${this.merkleFile}`);

        } else {
            // Old format (backward compatibility)
            const whitelistData = {
                addresses: data.addresses,
                merkleRoot: data.merkleRoot,
                createdAt: new Date().toISOString(),
                leafCount: data.addresses.length,
                nullifiers: data.nullifiers,
                simpleNullifiers: data.simpleNullifiers
            };

            fs.writeFileSync(this.whitelistFile, JSON.stringify(whitelistData, null, 2));
            console.log(`💾 Whitelist data saved to: ${this.whitelistFile}`);
        }
    }

    /**
     * Create a blacklist from some addresses (for demo purposes)
     * @param {number} count - Number of addresses to blacklist
     * @returns {string[]} Array of blacklisted addresses
     */
    async createBlacklist(count = 3) {
        const signers = await ethers.getSigners();
        // Use last few addresses as blacklisted ones
        const blacklistedAddresses = signers.slice(-count).map(signer => signer.address);

        console.log(`🚫 Created blacklist with ${blacklistedAddresses.length} addresses:`);
        blacklistedAddresses.forEach((addr, i) => {
            console.log(`   ${i + 1}. ${addr} (BLACKLISTED)`);
        });

        return blacklistedAddresses;
    }

    /**
     * Generate blacklist nullifier (more complex - includes challenge)
     * @param {string} userAddress - User's address
     * @param {string} blacklistRoot - Blacklist merkle root
     * @param {string} challengeHash - Challenge hash for non-membership proof
     * @returns {string} Blacklist nullifier hash
     */
    generateBlacklistNullifier(userAddress, blacklistRoot, challengeHash) {
        const userIdentity = ethers.keccak256(ethers.toUtf8Bytes(userAddress));
        const nullifier = ethers.keccak256(
            ethers.solidityPacked(
                ["bytes32", "bytes32", "bytes32"],
                [userIdentity, blacklistRoot, challengeHash]
            )
        );
        return nullifier;
    }

    /**
     * Generate simple blacklist nullifier for demo
     * @param {string} userAddress - User's address
     * @param {string} blacklistRoot - Blacklist merkle root
     * @param {string} challengeHash - Challenge hash
     * @returns {number} Simple numeric nullifier
     */
    generateSimpleBlacklistNullifier(userAddress, blacklistRoot, challengeHash) {
        const fullNullifier = this.generateBlacklistNullifier(userAddress, blacklistRoot, challengeHash);
        return parseInt(fullNullifier.slice(2, 8), 16);
    }

    /**
     * Generate compliance proof values for jurisdiction, accreditation, and aggregation
     * @returns {Object} Compliance proof values
     */
    generateComplianceValues() {
        const timestamp = Date.now();

        // Jurisdiction proof values
        const allowedJurisdictionsMask = 5; // Binary: 101 = US(1) + UK(4) allowed
        const userJurisdiction = 1; // User is from US
        const userSalt = parseInt(ethers.keccak256(ethers.toUtf8Bytes("jurisdiction_salt_" + timestamp)).slice(2, 10), 16);
        const jurisdictionCommitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [userJurisdiction, userSalt])
        );

        // Accreditation proof values
        const minimumAccreditation = 50; // Minimum level required
        const userAccreditation = 75; // User's actual level (hidden)
        const accreditationSalt = parseInt(ethers.keccak256(ethers.toUtf8Bytes("accreditation_salt_" + timestamp)).slice(2, 10), 16);
        const accreditationCommitment = ethers.keccak256(
            ethers.solidityPacked(["uint256", "uint256"], [userAccreditation, accreditationSalt])
        );

        // Compliance aggregation values
        const minimumComplianceScore = 75; // Minimum overall score required
        const kycScore = 85;
        const amlScore = 92;
        const jurisdictionScore = 78;
        const accreditationScore = 95;
        const complianceSalt = parseInt(ethers.keccak256(ethers.toUtf8Bytes("compliance_salt_" + timestamp)).slice(2, 10), 16);
        const complianceCommitment = ethers.keccak256(
            ethers.solidityPacked(
                ["uint256", "uint256", "uint256", "uint256", "uint256"],
                [kycScore, amlScore, jurisdictionScore, accreditationScore, complianceSalt]
            )
        );

        return {
            jurisdiction: {
                allowedMask: allowedJurisdictionsMask,
                commitmentHash: jurisdictionCommitment,
                userJurisdiction: userJurisdiction, // Hidden in real use
                userSalt: userSalt // Hidden in real use
            },
            accreditation: {
                minimumLevel: minimumAccreditation,
                commitmentHash: accreditationCommitment,
                userLevel: userAccreditation, // Hidden in real use
                userSalt: accreditationSalt // Hidden in real use
            },
            aggregation: {
                minimumScore: minimumComplianceScore,
                commitmentHash: complianceCommitment,
                scores: { // Hidden in real use
                    kyc: kycScore,
                    aml: amlScore,
                    jurisdiction: jurisdictionScore,
                    accreditation: accreditationScore
                },
                userSalt: complianceSalt // Hidden in real use
            }
        };
    }

    /**
     * Generate complete dataset for demo and production
     */
    async generateCompleteDataset() {
        console.log("🚀 GENERATING COMPLETE MERKLE DATASET");
        console.log("=" .repeat(50));

        // 1. Create whitelist
        const addresses = await this.createWhitelist(10);

        // 2. Create blacklist
        const blacklistedAddresses = await this.createBlacklist(3);

        // 3. Build Whitelist Merkle tree
        console.log("\n🌳 Building WHITELIST Merkle tree...");
        const whitelistTreeData = this.buildMerkleTree(addresses);

        // 4. Build Blacklist Merkle tree
        console.log("\n🚫 Building BLACKLIST Merkle tree...");
        const blacklistTreeData = this.buildMerkleTree(blacklistedAddresses);

        // 5. Generate whitelist nullifiers
        console.log("\n🔒 Generating WHITELIST nullifiers...");
        const whitelistNullifiers = {};
        const simpleWhitelistNullifiers = {};
        addresses.forEach(addr => {
            const nullifier = this.generateNullifier(addr, whitelistTreeData.root);
            const simpleNullifier = this.generateSimpleNullifier(addr, whitelistTreeData.root);
            whitelistNullifiers[addr] = nullifier;
            simpleWhitelistNullifiers[addr] = simpleNullifier;
            console.log(`   ✅ ${addr}: ${simpleNullifier}`);
        });

        // 6. Generate blacklist nullifiers (for non-membership proofs)
        console.log("\n🚫 Generating BLACKLIST nullifiers (non-membership proofs)...");
        const challengeHash = ethers.keccak256(ethers.toUtf8Bytes("blacklist_challenge_" + Date.now()));
        const blacklistNullifiers = {};
        const simpleBlacklistNullifiers = {};

        // Generate nullifiers for ALL users (both blacklisted and non-blacklisted)
        const allUsers = [...addresses, ...blacklistedAddresses];
        const uniqueUsers = [...new Set(allUsers)]; // Remove duplicates

        uniqueUsers.forEach(addr => {
            const nullifier = this.generateBlacklistNullifier(addr, blacklistTreeData.root, challengeHash);
            const simpleNullifier = this.generateSimpleBlacklistNullifier(addr, blacklistTreeData.root, challengeHash);
            blacklistNullifiers[addr] = nullifier;
            simpleBlacklistNullifiers[addr] = simpleNullifier;

            const isBlacklisted = blacklistedAddresses.includes(addr);
            const status = isBlacklisted ? "❌ BLACKLISTED" : "✅ NOT BLACKLISTED";
            console.log(`   ${status} ${addr}: ${simpleNullifier}`);
        });

        // 7. Save all data
        const completeData = {
            whitelist: {
                addresses: addresses,
                merkleRoot: whitelistTreeData.root,
                nullifiers: whitelistNullifiers,
                simpleNullifiers: simpleWhitelistNullifiers,
                treeData: whitelistTreeData
            },
            blacklist: {
                addresses: blacklistedAddresses,
                merkleRoot: blacklistTreeData.root,
                challengeHash: challengeHash,
                nullifiers: blacklistNullifiers,
                simpleNullifiers: simpleBlacklistNullifiers,
                treeData: blacklistTreeData
            }
        };

        this.saveData(completeData);

        // 8. Generate demo values
        console.log("\n🎯 DEMO VALUES FOR INTERACTIVE USE:");
        console.log("=" .repeat(40));
        console.log("📋 WHITELIST:");
        console.log(`   Merkle Root: ${whitelistTreeData.root}`);
        console.log(`   Sample Nullifier: ${simpleWhitelistNullifiers[addresses[0]]}`);

        console.log("\n🚫 BLACKLIST:");
        console.log(`   Merkle Root: ${blacklistTreeData.root}`);
        console.log(`   Challenge Hash: ${challengeHash}`);
        console.log(`   Sample Nullifier (non-blacklisted user): ${simpleBlacklistNullifiers[addresses[0]]}`);

        // 9. Generate compliance proof values
        console.log("\n🔐 Generating COMPLIANCE PROOF values...");
        const complianceData = this.generateComplianceValues();

        console.log("\n💡 COPY-PASTE VALUES FOR DEMO:");
        console.log("=" .repeat(30));
        console.log("WHITELIST Merkle Root:");
        console.log(whitelistTreeData.root);
        console.log("\nWHITELIST Nullifier Hash:");
        console.log(simpleWhitelistNullifiers[addresses[0]]);
        console.log("\nBLACKLIST Merkle Root:");
        console.log(blacklistTreeData.root);
        console.log("\nBLACKLIST Challenge Hash:");
        console.log(challengeHash);
        console.log("\nBLACKLIST Nullifier Hash:");
        console.log(simpleBlacklistNullifiers[addresses[0]]);

        console.log("\n🌍 JURISDICTION PROOF:");
        console.log(`Allowed Jurisdictions Mask: ${complianceData.jurisdiction.allowedMask}`);
        console.log(`Commitment Hash: ${complianceData.jurisdiction.commitmentHash}`);

        console.log("\n🎓 ACCREDITATION PROOF:");
        console.log(`Minimum Accreditation Level: ${complianceData.accreditation.minimumLevel}`);
        console.log(`Commitment Hash: ${complianceData.accreditation.commitmentHash}`);

        console.log("\n📊 COMPLIANCE AGGREGATION:");
        console.log(`Minimum Compliance Score: ${complianceData.aggregation.minimumScore}`);
        console.log(`Commitment Hash: ${complianceData.aggregation.commitmentHash}`);

        return completeData;
    }

    /**
     * Get demo values for specific user
     * @param {string} userAddress - Optional specific user address
     * @returns {Object} Demo values
     */
    getDemoValues(userAddress = null) {
        if (!fs.existsSync(this.whitelistFile)) {
            throw new Error("Whitelist data not found. Run generateCompleteDataset() first.");
        }

        const data = JSON.parse(fs.readFileSync(this.whitelistFile, 'utf8'));

        // Handle both old format and new format
        if (data.whitelist && data.blacklist) {
            // New format with both whitelist and blacklist
            const targetAddress = userAddress || data.whitelist.addresses[0];

            return {
                whitelist: {
                    merkleRoot: data.whitelist.merkleRoot,
                    nullifierHash: data.whitelist.simpleNullifiers[targetAddress],
                    userAddress: targetAddress
                },
                blacklist: {
                    merkleRoot: data.blacklist.merkleRoot,
                    challengeHash: data.blacklist.challengeHash,
                    nullifierHash: data.blacklist.simpleNullifiers[targetAddress],
                    userAddress: targetAddress
                }
            };
        } else {
            // Old format (backward compatibility)
            const targetAddress = userAddress || data.addresses[0];
            const simpleNullifier = data.simpleNullifiers ?
                data.simpleNullifiers[targetAddress] :
                this.generateSimpleNullifier(targetAddress, data.merkleRoot);

            return {
                merkleRoot: data.merkleRoot,
                nullifierHash: simpleNullifier,
                userAddress: targetAddress
            };
        }
    }

    /**
     * Interactive demo helper
     */
    async interactiveDemo() {
        console.log("🎯 INTERACTIVE MERKLE DATA DEMO");
        console.log("=" .repeat(40));

        // Generate complete dataset
        const data = await this.generateCompleteDataset();

        // Show usage examples for different users
        console.log("\n🔄 VALUES FOR DIFFERENT USERS:");
        console.log("=" .repeat(30));

        // Show whitelist users
        console.log("\n📋 WHITELIST USERS:");
        data.whitelist.addresses.slice(0, 3).forEach((addr, i) => {
            console.log(`👤 User ${i + 1}: ${addr}`);
            console.log(`   📋 Whitelist Root: ${data.whitelist.merkleRoot}`);
            console.log(`   🔒 Whitelist Nullifier: ${data.whitelist.simpleNullifiers[addr]}`);
            console.log(`   🚫 Blacklist Nullifier: ${data.blacklist.simpleNullifiers[addr]}`);
        });

        // Show blacklisted users
        console.log("\n🚫 BLACKLISTED USERS:");
        data.blacklist.addresses.forEach((addr, i) => {
            console.log(`❌ Blacklisted User ${i + 1}: ${addr}`);
            console.log(`   🚫 Blacklist Root: ${data.blacklist.merkleRoot}`);
            console.log(`   🔒 Blacklist Nullifier: ${data.blacklist.simpleNullifiers[addr]}`);
        });

        console.log("\n✅ Data ready for use in interactive demo!");
        console.log("💡 Use the values above when prompted in the demo!");
    }
}

// Export for use in other scripts
module.exports = MerkleDataGenerator;

// Run demo if called directly
if (require.main === module) {
    async function main() {
        try {
            const generator = new MerkleDataGenerator();
            await generator.interactiveDemo();
        } catch (error) {
            console.error("❌ Error:", error.message);
            process.exit(1);
        }
    }
    
    main();
}
