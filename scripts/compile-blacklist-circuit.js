const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * @title Blacklist Circuit Compilation Script
 * @dev Compiles the blacklist_membership circuit that's missing from builds
 */

const CIRCUITS_DIR = path.join(__dirname, '../circuits');
const BUILD_DIR = path.join(__dirname, '../build/circuits');
const PTAU_FILE = path.join(BUILD_DIR, 'powersOfTau28_hez_final_15.ptau');

const CIRCUIT_NAME = 'blacklist_membership';

class BlacklistCircuitCompiler {
    constructor() {
        this.circuitPath = path.join(CIRCUITS_DIR, `${CIRCUIT_NAME}.circom`);
        this.buildPath = path.join(BUILD_DIR, CIRCUIT_NAME);
    }

    /**
     * Ensure build directory exists
     */
    ensureDirectories() {
        console.log('📁 Creating build directories...');
        
        if (!fs.existsSync(this.buildPath)) {
            fs.mkdirSync(this.buildPath, { recursive: true });
            console.log(`✅ Created: ${this.buildPath}`);
        } else {
            console.log(`⚠️  Directory already exists: ${this.buildPath}`);
        }
    }

    /**
     * Check if circuit source file exists
     */
    checkCircuitSource() {
        console.log('\n🔍 Checking circuit source...');
        
        if (!fs.existsSync(this.circuitPath)) {
            console.log(`❌ Circuit source not found: ${this.circuitPath}`);
            throw new Error('Circuit source file missing');
        }
        
        console.log(`✅ Circuit source found: ${this.circuitPath}`);
        
        // Read and display circuit info
        const circuitContent = fs.readFileSync(this.circuitPath, 'utf8');
        const templateMatch = circuitContent.match(/template\s+(\w+)\s*\(([^)]*)\)/);
        if (templateMatch) {
            console.log(`   Template: ${templateMatch[1]}`);
            console.log(`   Parameters: ${templateMatch[2] || 'none'}`);
        }
    }

    /**
     * Compile circuit to R1CS and WASM
     */
    async compileCircuit() {
        console.log('\n🔧 Compiling circuit...');
        console.log('   This may take 30-60 seconds...');

        const includeDir = path.join(__dirname, '../node_modules');
        const command = `circom ${this.circuitPath} --r1cs --wasm --sym -o ${this.buildPath} -l ${includeDir}`;

        try {
            console.log(`   Command: ${command}`);
            const { stdout, stderr } = await execAsync(command);
            
            if (stdout) console.log(stdout);
            if (stderr && !stderr.includes('Everything went okay')) {
                console.log(stderr);
            }
            
            console.log('✅ Circuit compiled successfully');
            
            // Verify outputs
            const r1csPath = path.join(this.buildPath, `${CIRCUIT_NAME}.r1cs`);
            const wasmDir = path.join(this.buildPath, `${CIRCUIT_NAME}_js`);
            
            if (fs.existsSync(r1csPath)) {
                const size = (fs.statSync(r1csPath).size / 1024).toFixed(2);
                console.log(`   ✅ R1CS generated (${size} KB)`);
            }
            
            if (fs.existsSync(wasmDir)) {
                console.log(`   ✅ WASM witness calculator generated`);
            }
            
            return true;
        } catch (error) {
            console.log(`❌ Compilation failed: ${error.message}`);
            
            // Check if circom is installed
            try {
                await execAsync('circom --version');
            } catch {
                console.log('\n💡 Circom not found. Install with:');
                console.log('   npm install -g circom');
                console.log('   or visit: https://docs.circom.io/getting-started/installation/');
            }
            
            throw error;
        }
    }

    /**
     * Generate proving key
     */
    async generateProvingKey() {
        console.log('\n🔑 Generating proving key...');
        console.log('   This may take 1-2 minutes...');

        // Check if PTAU file exists
        if (!fs.existsSync(PTAU_FILE)) {
            console.log(`⚠️  PTAU file not found: ${PTAU_FILE}`);
            console.log('   Using existing PTAU or creating placeholder...');
        }

        const r1csPath = path.join(this.buildPath, `${CIRCUIT_NAME}.r1cs`);
        const zkeyPath = path.join(this.buildPath, `${CIRCUIT_NAME}.zkey`);

        try {
            // Use snarkjs to generate proving key
            const snarkjs = require('snarkjs');
            
            console.log('   Running Groth16 setup...');
            await snarkjs.groth16.setup(r1csPath, PTAU_FILE, zkeyPath);
            
            console.log('✅ Proving key generated');
            
            const size = (fs.statSync(zkeyPath).size / 1024).toFixed(2);
            console.log(`   ✅ ${CIRCUIT_NAME}.zkey (${size} KB)`);
            
            return true;
        } catch (error) {
            console.log(`❌ Key generation failed: ${error.message}`);
            
            // Check if snarkjs is installed
            try {
                require('snarkjs');
            } catch {
                console.log('\n💡 snarkjs not found. Install with:');
                console.log('   npm install snarkjs');
            }
            
            throw error;
        }
    }

    /**
     * Export verification key
     */
    async exportVerificationKey() {
        console.log('\n📤 Exporting verification key...');

        const zkeyPath = path.join(this.buildPath, `${CIRCUIT_NAME}.zkey`);
        const vkeyPath = path.join(this.buildPath, `${CIRCUIT_NAME}_vkey.json`);

        try {
            const snarkjs = require('snarkjs');
            
            const vkey = await snarkjs.zKey.exportVerificationKey(zkeyPath);
            fs.writeFileSync(vkeyPath, JSON.stringify(vkey, null, 2));
            
            console.log('✅ Verification key exported');
            console.log(`   Protocol: ${vkey.protocol}`);
            console.log(`   Curve: ${vkey.curve}`);
            console.log(`   Public inputs: ${vkey.nPublic}`);
            
            return true;
        } catch (error) {
            console.log(`❌ Export failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Run complete compilation process
     */
    async compile() {
        console.log('\n🔐 BLACKLIST CIRCUIT COMPILATION');
        console.log('='.repeat(60));
        console.log(`Circuit: ${CIRCUIT_NAME}`);
        console.log(`Source: ${this.circuitPath}`);
        console.log(`Output: ${this.buildPath}\n`);

        try {
            // Step 1: Prepare directories
            this.ensureDirectories();

            // Step 2: Check source file
            this.checkCircuitSource();

            // Step 3: Compile circuit
            await this.compileCircuit();

            // Step 4: Generate proving key
            await this.generateProvingKey();

            // Step 5: Export verification key
            await this.exportVerificationKey();

            // Success!
            console.log('\n' + '='.repeat(60));
            console.log('🎉 COMPILATION SUCCESSFUL!');
            console.log('='.repeat(60));
            console.log('✅ Circuit compiled');
            console.log('✅ Proving key generated');
            console.log('✅ Verification key exported');
            console.log('\n✅ blacklist_membership circuit is ready for production!');
            console.log('\n' + '='.repeat(60));

        } catch (error) {
            console.log('\n' + '='.repeat(60));
            console.log('❌ COMPILATION FAILED');
            console.log('='.repeat(60));
            console.log(`Error: ${error.message}`);
            console.log('\n💡 TROUBLESHOOTING:');
            console.log('1. Ensure circom is installed: circom --version');
            console.log('2. Ensure snarkjs is installed: npm list snarkjs');
            console.log('3. Check circuit syntax: circom --help');
            console.log('4. Verify PTAU file exists in build/circuits/');
            console.log('\n' + '='.repeat(60));
            process.exit(1);
        }
    }
}

// Run compilation
if (require.main === module) {
    const compiler = new BlacklistCircuitCompiler();
    compiler.compile().catch(error => {
        console.error(`\n❌ Fatal error: ${error.message}`);
        process.exit(1);
    });
}

module.exports = BlacklistCircuitCompiler;

