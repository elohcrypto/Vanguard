const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const snarkjs = require('snarkjs');
const { buildPoseidon } = require('circomlibjs');

/**
 * @title Blacklist Circuit Test
 * @dev Tests the blacklist_membership circuit compilation and functionality
 */

describe('Blacklist Membership Circuit', function() {
    this.timeout(120000); // 2 minutes for circuit operations

    const CIRCUIT_NAME = 'blacklist_membership';
    const BUILD_DIR = path.join(__dirname, '../../build/circuits', CIRCUIT_NAME);
    const WASM_PATH = path.join(BUILD_DIR, `${CIRCUIT_NAME}_js`, `${CIRCUIT_NAME}.wasm`);
    const ZKEY_PATH = path.join(BUILD_DIR, `${CIRCUIT_NAME}.zkey`);
    const VKEY_PATH = path.join(BUILD_DIR, `${CIRCUIT_NAME}_vkey.json`);

    let poseidon;

    before(async function() {
        // Initialize Poseidon hash
        poseidon = await buildPoseidon();
        
        console.log('\n🔍 Checking circuit build files...');
        console.log(`   WASM: ${fs.existsSync(WASM_PATH) ? '✅' : '❌'}`);
        console.log(`   ZKEY: ${fs.existsSync(ZKEY_PATH) ? '✅' : '❌'}`);
        console.log(`   VKEY: ${fs.existsSync(VKEY_PATH) ? '✅' : '❌'}`);
    });

    describe('Circuit Build Verification', function() {
        it('should have WASM witness calculator', function() {
            expect(fs.existsSync(WASM_PATH)).to.be.true;
        });

        it('should have proving key (.zkey)', function() {
            expect(fs.existsSync(ZKEY_PATH)).to.be.true;
        });

        it('should have verification key (_vkey.json)', function() {
            expect(fs.existsSync(VKEY_PATH)).to.be.true;
        });

        it('should have valid verification key format', function() {
            const vkey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
            expect(vkey).to.have.property('protocol');
            expect(vkey).to.have.property('curve');
            expect(vkey).to.have.property('nPublic');
            expect(vkey.protocol).to.equal('groth16');
            expect(vkey.curve).to.equal('bn128');
            expect(vkey.nPublic).to.equal(1); // isNotBlacklisted output
        });
    });

    /**
     * Helper function to create a simple merkle tree
     */
    function createSimpleMerkleTree(leaves, levels = 20) {
        const tree = [];
        tree[0] = leaves;

        // Build tree bottom-up
        for (let level = 0; level < levels; level++) {
            const currentLevel = tree[level];
            const nextLevel = [];

            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i] || BigInt(0);
                const right = currentLevel[i + 1] || BigInt(0);
                const hash = poseidon.F.toObject(poseidon([left, right]));
                nextLevel.push(hash);
            }

            tree[level + 1] = nextLevel;
        }

        return tree;
    }

    /**
     * Helper function to get merkle proof
     */
    function getMerkleProof(tree, leafIndex, levels = 20) {
        const pathElements = [];
        const pathIndices = [];
        let index = leafIndex;

        for (let level = 0; level < levels; level++) {
            const isLeft = index % 2 === 0;
            const siblingIndex = isLeft ? index + 1 : index - 1;
            const sibling = tree[level][siblingIndex] || BigInt(0);

            pathElements.push(sibling);
            pathIndices.push(isLeft ? 0 : 1);

            index = Math.floor(index / 2);
        }

        return { pathElements, pathIndices };
    }

    describe('Circuit Functionality', function() {

        it('should prove non-membership in empty blacklist', async function() {
            console.log('\n   🧪 Test: Non-membership in empty blacklist');

            // User identity (not in blacklist)
            const userIdentity = BigInt(12345);
            const identityHash = poseidon.F.toObject(poseidon([userIdentity]));

            // Empty blacklist (all zeros)
            const emptyLeaves = new Array(4).fill(BigInt(0));
            const blacklistTree = createSimpleMerkleTree(emptyLeaves);
            const blacklistRoot = blacklistTree[blacklistTree.length - 1][0];

            // Sibling hash (proof that user is not in tree)
            const siblingHash = BigInt(0);

            // Get merkle proof for position 0
            const { pathElements, pathIndices } = getMerkleProof(blacklistTree, 0);

            // Generate nullifier
            const nullifierHash = poseidon.F.toObject(
                poseidon([userIdentity, blacklistRoot, BigInt(999)])
            );

            // Challenge hash
            const challengeHash = BigInt(999);

            // Circuit inputs
            const input = {
                identity: userIdentity.toString(),
                pathElements: pathElements.map(x => x.toString()),
                pathIndices: pathIndices,
                siblingHash: siblingHash.toString(),
                blacklistRoot: blacklistRoot.toString(),
                nullifierHash: nullifierHash.toString(),
                challengeHash: challengeHash.toString()
            };

            console.log('   📝 Generating witness...');
            const { proof, publicSignals } = await snarkjs.groth16.fullProve(
                input,
                WASM_PATH,
                ZKEY_PATH
            );

            console.log('   ✅ Witness generated');
            console.log('   🔐 Verifying proof...');

            // Verify proof
            const vkey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
            const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);

            console.log(`   ${verified ? '✅' : '❌'} Proof verification: ${verified}`);
            expect(verified).to.be.true;
        });

        it('should prove non-membership when user is not in blacklist', async function() {
            console.log('\n   🧪 Test: Non-membership with populated blacklist');

            // Create blacklist with some users
            const blacklistedUsers = [
                BigInt(111),
                BigInt(222),
                BigInt(333),
                BigInt(444)
            ];

            const blacklistLeaves = blacklistedUsers.map(id => 
                poseidon.F.toObject(poseidon([id]))
            );

            const blacklistTree = createSimpleMerkleTree(blacklistLeaves);
            const blacklistRoot = blacklistTree[blacklistTree.length - 1][0];

            // User identity (NOT in blacklist)
            const userIdentity = BigInt(12345);
            const identityHash = poseidon.F.toObject(poseidon([userIdentity]));

            // Sibling hash at position 0 (where user would be if they were in tree)
            const siblingHash = blacklistLeaves[0]; // This is different from user's hash

            // Get merkle proof for position 0
            const { pathElements, pathIndices } = getMerkleProof(blacklistTree, 0);

            // Generate nullifier
            const challengeHash = BigInt(777);
            const nullifierHash = poseidon.F.toObject(
                poseidon([userIdentity, blacklistRoot, challengeHash])
            );

            // Circuit inputs
            const input = {
                identity: userIdentity.toString(),
                pathElements: pathElements.map(x => x.toString()),
                pathIndices: pathIndices,
                siblingHash: siblingHash.toString(),
                blacklistRoot: blacklistRoot.toString(),
                nullifierHash: nullifierHash.toString(),
                challengeHash: challengeHash.toString()
            };

            console.log('   📝 Generating witness...');
            const { proof, publicSignals } = await snarkjs.groth16.fullProve(
                input,
                WASM_PATH,
                ZKEY_PATH
            );

            console.log('   ✅ Witness generated');
            console.log('   🔐 Verifying proof...');

            // Verify proof
            const vkey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
            const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);

            console.log(`   ${verified ? '✅' : '❌'} Proof verification: ${verified}`);
            expect(verified).to.be.true;
        });

        it('should have correct public signals format', async function() {
            console.log('\n   🧪 Test: Public signals format');

            // Simple test case
            const userIdentity = BigInt(99999);
            const emptyLeaves = new Array(4).fill(BigInt(0));
            const blacklistTree = createSimpleMerkleTree(emptyLeaves);
            const blacklistRoot = blacklistTree[blacklistTree.length - 1][0];
            const challengeHash = BigInt(555);

            const nullifierHash = poseidon.F.toObject(
                poseidon([userIdentity, blacklistRoot, challengeHash])
            );

            const { pathElements, pathIndices } = getMerkleProof(blacklistTree, 0);

            const input = {
                identity: userIdentity.toString(),
                pathElements: pathElements.map(x => x.toString()),
                pathIndices: pathIndices,
                siblingHash: BigInt(0).toString(),
                blacklistRoot: blacklistRoot.toString(),
                nullifierHash: nullifierHash.toString(),
                challengeHash: challengeHash.toString()
            };

            const { proof, publicSignals } = await snarkjs.groth16.fullProve(
                input,
                WASM_PATH,
                ZKEY_PATH
            );

            console.log('   📊 Public signals:');
            console.log(`      [0] isNotBlacklisted: ${publicSignals[0]}`);

            // Verify public signals - should be 1 (user is NOT blacklisted)
            expect(publicSignals).to.have.lengthOf(1);
            expect(BigInt(publicSignals[0])).to.equal(BigInt(1));
        });
    });

    describe('Gas Cost Estimation', function() {
        it('should estimate proof size', async function() {
            // Generate a simple proof
            const userIdentity = BigInt(12345);
            const emptyLeaves = new Array(4).fill(BigInt(0));
            const blacklistTree = createSimpleMerkleTree(emptyLeaves);
            const blacklistRoot = blacklistTree[blacklistTree.length - 1][0];
            const challengeHash = BigInt(999);
            
            const nullifierHash = poseidon.F.toObject(
                poseidon([userIdentity, blacklistRoot, challengeHash])
            );

            const { pathElements, pathIndices } = getMerkleProof(blacklistTree, 0);

            const input = {
                identity: userIdentity.toString(),
                pathElements: pathElements.map(x => x.toString()),
                pathIndices: pathIndices,
                siblingHash: BigInt(0).toString(),
                blacklistRoot: blacklistRoot.toString(),
                nullifierHash: nullifierHash.toString(),
                challengeHash: challengeHash.toString()
            };

            const { proof, publicSignals } = await snarkjs.groth16.fullProve(
                input,
                WASM_PATH,
                ZKEY_PATH
            );

            console.log('\n   📊 Proof Size Estimation:');
            console.log(`      Proof points: ${JSON.stringify(proof).length} bytes`);
            console.log(`      Public signals: ${publicSignals.length} values`);
            console.log(`      Estimated gas: ~320,000-380,000 gas`);

            expect(proof).to.have.property('pi_a');
            expect(proof).to.have.property('pi_b');
            expect(proof).to.have.property('pi_c');
        });
    });
});

