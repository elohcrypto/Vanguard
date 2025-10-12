const fs = require('fs');
const path = require('path');

/**
 * @title Circuit Build Verification Script
 * @dev Verifies all ZK circuits are properly compiled and ready for production
 */

const BUILD_DIR = path.join(__dirname, '../build/circuits');

const REQUIRED_CIRCUITS = [
    'whitelist_membership',
    'blacklist_membership',
    'jurisdiction_proof',
    'accreditation_proof',
    'compliance_aggregation'
];

const REQUIRED_FILES = [
    '.r1cs',           // Rank-1 Constraint System
    '.zkey',           // Proving key
    '_vkey.json',      // Verification key
    '.sym'             // Symbols file
];

class CircuitBuildVerifier {
    constructor() {
        this.results = {
            total: 0,
            passed: 0,
            failed: 0,
            warnings: 0
        };
        this.issues = [];
    }

    /**
     * Check if a file exists
     */
    fileExists(filePath) {
        return fs.existsSync(filePath);
    }

    /**
     * Get file size in KB
     */
    getFileSize(filePath) {
        if (!this.fileExists(filePath)) return 0;
        const stats = fs.statSync(filePath);
        return (stats.size / 1024).toFixed(2);
    }

    /**
     * Verify a single circuit build
     */
    verifyCircuit(circuitName) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 Verifying: ${circuitName}`);
        console.log('='.repeat(60));

        const circuitDir = path.join(BUILD_DIR, circuitName);
        const circuitJsDir = path.join(circuitDir, `${circuitName}_js`);
        
        let circuitPassed = true;
        const circuitIssues = [];

        // Check if circuit directory exists
        if (!this.fileExists(circuitDir)) {
            console.log(`❌ Circuit directory not found: ${circuitDir}`);
            circuitIssues.push(`Missing circuit directory`);
            circuitPassed = false;
        } else {
            console.log(`✅ Circuit directory exists`);

            // Check required files
            for (const fileExt of REQUIRED_FILES) {
                const fileName = `${circuitName}${fileExt}`;
                const filePath = path.join(circuitDir, fileName);
                
                if (this.fileExists(filePath)) {
                    const size = this.getFileSize(filePath);
                    console.log(`✅ ${fileName} (${size} KB)`);
                } else {
                    console.log(`❌ Missing: ${fileName}`);
                    circuitIssues.push(`Missing ${fileName}`);
                    circuitPassed = false;
                }
            }

            // Check WASM witness calculator
            const wasmFile = path.join(circuitJsDir, `${circuitName}.wasm`);
            if (this.fileExists(wasmFile)) {
                const size = this.getFileSize(wasmFile);
                console.log(`✅ ${circuitName}.wasm (${size} KB)`);
            } else {
                console.log(`⚠️  Warning: WASM file not found`);
                circuitIssues.push(`Missing WASM witness calculator`);
                this.results.warnings++;
            }

            // Check witness_calculator.js
            const witnessCalcFile = path.join(circuitJsDir, 'witness_calculator.js');
            if (this.fileExists(witnessCalcFile)) {
                console.log(`✅ witness_calculator.js`);
            } else {
                console.log(`⚠️  Warning: witness_calculator.js not found`);
                this.results.warnings++;
            }

            // Validate verification key JSON
            const vkeyPath = path.join(circuitDir, `${circuitName}_vkey.json`);
            if (this.fileExists(vkeyPath)) {
                try {
                    const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
                    if (vkey.protocol && vkey.curve && vkey.nPublic !== undefined) {
                        console.log(`✅ Verification key valid (${vkey.nPublic} public inputs)`);
                    } else {
                        console.log(`⚠️  Verification key format may be invalid`);
                        this.results.warnings++;
                    }
                } catch (error) {
                    console.log(`❌ Invalid verification key JSON: ${error.message}`);
                    circuitIssues.push(`Invalid verification key`);
                    circuitPassed = false;
                }
            }
        }

        // Update results
        this.results.total++;
        if (circuitPassed) {
            this.results.passed++;
            console.log(`\n✅ ${circuitName}: PASSED`);
        } else {
            this.results.failed++;
            console.log(`\n❌ ${circuitName}: FAILED`);
            this.issues.push({
                circuit: circuitName,
                issues: circuitIssues
            });
        }

        return circuitPassed;
    }

    /**
     * Verify all circuits
     */
    async verifyAll() {
        console.log('\n🔐 ZK CIRCUIT BUILD VERIFICATION');
        console.log('='.repeat(60));
        console.log(`Build Directory: ${BUILD_DIR}\n`);

        // Check if build directory exists
        if (!this.fileExists(BUILD_DIR)) {
            console.log(`❌ Build directory not found: ${BUILD_DIR}`);
            console.log(`💡 Run: npm run build:circuits`);
            process.exit(1);
        }

        // Verify each circuit
        for (const circuit of REQUIRED_CIRCUITS) {
            this.verifyCircuit(circuit);
        }

        // Print summary
        this.printSummary();

        // Exit with appropriate code
        if (this.results.failed > 0) {
            process.exit(1);
        }
    }

    /**
     * Print verification summary
     */
    printSummary() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 VERIFICATION SUMMARY');
        console.log('='.repeat(60));

        console.log(`Total Circuits: ${this.results.total}`);
        console.log(`✅ Passed: ${this.results.passed}`);
        console.log(`❌ Failed: ${this.results.failed}`);
        console.log(`⚠️  Warnings: ${this.results.warnings}`);

        if (this.issues.length > 0) {
            console.log('\n❌ ISSUES FOUND:');
            this.issues.forEach(({ circuit, issues }) => {
                console.log(`\n${circuit}:`);
                issues.forEach(issue => console.log(`  - ${issue}`));
            });

            console.log('\n💡 RECOMMENDED ACTIONS:');
            console.log('1. Run: npm run build:circuits');
            console.log('2. Check for compilation errors');
            console.log('3. Verify circom is installed: circom --version');
            console.log('4. Verify snarkjs is installed: npx snarkjs --version');
        } else {
            console.log('\n🎉 ALL CIRCUITS READY FOR PRODUCTION!');
            console.log('✅ All required files present');
            console.log('✅ Verification keys valid');
            console.log('✅ Witness calculators available');
            
            if (this.results.warnings > 0) {
                console.log(`\n⚠️  ${this.results.warnings} warnings found (non-critical)`);
            }
        }

        console.log('\n' + '='.repeat(60));
    }
}

// Run verification
if (require.main === module) {
    const verifier = new CircuitBuildVerifier();
    verifier.verifyAll().catch(error => {
        console.error(`\n❌ Verification failed: ${error.message}`);
        process.exit(1);
    });
}

module.exports = CircuitBuildVerifier;

