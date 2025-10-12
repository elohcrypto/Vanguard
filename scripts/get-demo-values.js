const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Quick Demo Values Generator
 * Get merkle root and nullifier hash values for interactive demo
 */
async function getDemoValues() {
    console.log("🎯 DEMO VALUES FOR INTERACTIVE PROOF SUBMISSION");
    console.log("=" .repeat(55));
    
    const dataFile = path.join(__dirname, "../data/whitelist-data.json");
    
    // Check if we have saved data
    if (fs.existsSync(dataFile)) {
        console.log("📋 Using saved merkle data...");
        const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

        // Handle both old format and new format
        if (data.whitelist && data.blacklist) {
            // New format with both whitelist and blacklist
            console.log("\n🎯 WHITELIST VALUES:");
            console.log("=" .repeat(25));
            console.log("📋 Whitelist Merkle Root:");
            console.log(data.whitelist.merkleRoot);

            const firstWhitelistNullifier = Object.values(data.whitelist.simpleNullifiers)[0];
            console.log("\n🔒 Whitelist Nullifier Hash (User 1):");
            console.log(firstWhitelistNullifier);

            console.log("\n🚫 BLACKLIST VALUES:");
            console.log("=" .repeat(25));
            console.log("📋 Blacklist Merkle Root:");
            console.log(data.blacklist.merkleRoot);

            console.log("\n🎯 Challenge Hash:");
            console.log(data.blacklist.challengeHash);

            const firstBlacklistNullifier = Object.values(data.blacklist.simpleNullifiers)[0];
            console.log("\n🔒 Blacklist Nullifier Hash (User 1):");
            console.log(firstBlacklistNullifier);

            console.log("\n🔄 WHITELIST USER NULLIFIERS:");
            console.log("=" .repeat(30));
            Object.entries(data.whitelist.simpleNullifiers).slice(0, 5).forEach(([addr, nullifier], i) => {
                console.log(`👤 User ${i + 1}: ${nullifier}`);
            });

            console.log("\n🚫 BLACKLIST STATUS:");
            console.log("=" .repeat(20));
            Object.entries(data.blacklist.simpleNullifiers).slice(0, 8).forEach(([addr, nullifier], i) => {
                const isBlacklisted = data.blacklist.addresses.includes(addr);
                const status = isBlacklisted ? "❌ BLACKLISTED" : "✅ NOT BLACKLISTED";
                console.log(`${status} User ${i + 1}: ${nullifier}`);
            });

            console.log("\n🔐 COMPLIANCE PROOF VALUES:");
            console.log("=" .repeat(30));
            console.log("🌍 JURISDICTION PROOF:");
            console.log("   Allowed Jurisdictions Mask: 5");
            console.log("   Commitment Hash: 0x417eb7b4096e57f93d32da14f7f87b8db00c8e48746456c1e784915acdea9fe0");

            console.log("\n🎓 ACCREDITATION PROOF:");
            console.log("   Minimum Accreditation Level: 50");
            console.log("   Commitment Hash: 0x2b5cd9824fdeafe7d6ba3124b2422c894707b9db98d8d11f3df26938f625ac02");

            console.log("\n📊 COMPLIANCE AGGREGATION:");
            console.log("   Minimum Compliance Score: 75");
            console.log("   Commitment Hash: 0xd2f60de91ce5f5293390c90425f8cb19a0a42859d5cb1c9b3b6873fe2457da2c");

        } else {
            // Old format (backward compatibility)
            console.log("\n🎯 COPY-PASTE VALUES:");
            console.log("=" .repeat(25));
            console.log("📋 Merkle Root:");
            console.log(data.merkleRoot);
            // Get simple numeric nullifiers if available
            const firstNullifier = data.simpleNullifiers ?
                Object.values(data.simpleNullifiers)[0] :
                parseInt(Object.values(data.nullifiers)[0].slice(2, 8), 16);

            console.log("\n🔒 Nullifier Hash (User 1):");
            console.log(firstNullifier);

            console.log("\n🔄 OTHER USER NULLIFIERS:");
            console.log("=" .repeat(25));

            if (data.simpleNullifiers) {
                Object.entries(data.simpleNullifiers).slice(0, 5).forEach(([addr, nullifier], i) => {
                    console.log(`👤 User ${i + 1}: ${nullifier}`);
                });
            } else {
                Object.entries(data.nullifiers).slice(0, 5).forEach(([addr, nullifier], i) => {
                    const simpleNullifier = parseInt(nullifier.slice(2, 8), 16);
                    console.log(`👤 User ${i + 1}: ${simpleNullifier}`);
                });
            }
        }
        
    } else {
        console.log("⚠️  No saved data found. Generating fresh values...");
        
        // Generate fresh values
        const signers = await ethers.getSigners();
        const userAddress = signers[0].address;
        
        // Create a simple merkle root
        const merkleRoot = ethers.keccak256(
            ethers.toUtf8Bytes("demo_whitelist_" + Date.now())
        );
        
        // Create a simple nullifier
        const userIdentity = ethers.keccak256(ethers.toUtf8Bytes(userAddress));
        const nullifierFull = ethers.keccak256(
            ethers.solidityPacked(["bytes32", "bytes32"], [userIdentity, merkleRoot])
        );
        const nullifier = parseInt(nullifierFull.slice(2, 8), 16);
        
        console.log("\n🎯 FRESH DEMO VALUES:");
        console.log("=" .repeat(25));
        console.log("📋 Merkle Root:");
        console.log(merkleRoot);
        console.log("\n🔒 Nullifier Hash:");
        console.log(nullifier);
        console.log("\n👤 User Address:");
        console.log(userAddress);
    }
    
    console.log("\n💡 HOW TO USE:");
    console.log("=" .repeat(15));
    console.log("1. Run the interactive demo: npm run demo:interactive:proof");
    console.log("2. Choose option 41 to deploy Privacy & ZK Verification System");
    console.log("3. Choose option 42 to Submit Private Compliance Proofs");
    console.log("4. When prompted, paste the values above");
    console.log("5. Or press Enter to use demo defaults");
    
    console.log("\n✅ Ready to use in interactive demo!");
}

// Run if called directly
if (require.main === module) {
    getDemoValues().catch(console.error);
}

module.exports = { getDemoValues };
