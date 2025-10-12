#!/usr/bin/env node

/**
 * Test All Demos Script
 * Verifies that all demo scripts work properly
 */

const { spawn } = require('child_process');
const fs = require('fs');

class DemoTester {
    constructor() {
        this.results = {};
        this.hardhatProcess = null;
    }

    async startHardhatNode() {
        console.log('🚀 Starting Hardhat node...');

        return new Promise((resolve, reject) => {
            // Kill any existing hardhat processes
            spawn('pkill', ['-f', 'hardhat node'], { stdio: 'ignore' });

            setTimeout(() => {
                this.hardhatProcess = spawn('npx', ['hardhat', 'node', '--port', '8545'], {
                    stdio: 'pipe'
                });

                this.hardhatProcess.stdout.on('data', (data) => {
                    if (data.toString().includes('Started HTTP and WebSocket JSON-RPC server')) {
                        console.log('✅ Hardhat node started');
                        resolve();
                    }
                });

                this.hardhatProcess.stderr.on('data', (data) => {
                    console.error(`Hardhat error: ${data}`);
                });

                // Timeout after 10 seconds
                setTimeout(() => {
                    console.log('✅ Hardhat node should be ready');
                    resolve();
                }, 5000);
            }, 1000);
        });
    }

    async stopHardhatNode() {
        if (this.hardhatProcess) {
            this.hardhatProcess.kill();
            console.log('🛑 Hardhat node stopped');
        }
        // Also kill any remaining processes
        spawn('pkill', ['-f', 'hardhat node'], { stdio: 'ignore' });
    }

    async testDemo(demoName, command, timeout = 30000) {
        console.log(`\\n🧪 Testing ${demoName}...`); \n        console.log(`   Command: ${command}`); \n        \n        return new Promise((resolve) => { \n            const process = spawn('npm', ['run', command], { \n                stdio: 'pipe', \n                timeout: timeout\n }); \n\n            let output = ''; \n            let errorOutput = ''; \n\n            process.stdout.on('data', (data) => { \n                output += data.toString(); \n }); \n\n            process.stderr.on('data', (data) => { \n                errorOutput += data.toString(); \n }); \n\n            process.on('close', (code) => { \n                const success = code === 0 && !errorOutput.includes('Error:') && !output.includes('❌'); \n                \n                this.results[demoName] = { \n                    success, \n                    code, \n                    output: output.substring(0, 500), // First 500 chars\n                    error: errorOutput.substring(0, 500)\n                };\n\n                if (success) {\n                    console.log(`   ✅ ${demoName} - PASSED`);\n                } else {\n                    console.log(`   ❌ ${demoName} - FAILED (code: ${code})`);\n                    if (errorOutput) {\n                        console.log(`   Error: ${errorOutput.substring(0, 200)}...`);\n                    }\n                }\n                \n                resolve();\n            });\n\n            // Kill process after timeout\n            setTimeout(() => {\n                process.kill();\n                console.log(`   ⏰ ${demoName} - TIMEOUT`);\n                this.results[demoName] = {\n                    success: false,\n                    code: -1,\n                    output: 'TIMEOUT',\n                    error: 'Process timed out'\n                };\n                resolve();\n            }, timeout);\n        });\n    }\n\n    async runAllTests() {\n        console.log('🎯 DEMO TESTING SUITE');\n        console.log('='.repeat(50));\n\n        try {\n            // Start Hardhat node\n            await this.startHardhatNode();\n\n            // Test demos that require hardhat node\n            const hardhatDemos = [\n                ['Main Demo', 'demo:main'],\n                ['Final Proof', 'demo:final:proof'],\n                ['Comprehensive Working', 'demo:comprehensive:working']\n            ];\n\n            for (const [name, command] of hardhatDemos) {\n                await this.testDemo(name, command, 45000); // 45 second timeout\n                await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second pause\n            }\n\n            // Stop hardhat node\n            await this.stopHardhatNode();\n\n            // Test standalone demos (no hardhat node needed)\n            const standaloneDemos = [\n                ['UTXO Success', 'demo:utxo:success'],\n                ['Quick Demo', 'demo:quick']\n            ];\n\n            for (const [name, command] of standaloneDemos) {\n                await this.testDemo(name, command, 15000); // 15 second timeout\n                await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second pause\n            }\n\n            // Show final results\n            this.showResults();\n\n        } catch (error) {\n            console.error('❌ Test suite failed:', error.message);\n        } finally {\n            await this.stopHardhatNode();\n        }\n    }\n\n    showResults() {\n        console.log('\\n🎯 FINAL TEST RESULTS');\n        console.log('='.repeat(50));\n\n        const totalTests = Object.keys(this.results).length;\n        const passedTests = Object.values(this.results).filter(r => r.success).length;\n        const successRate = totalTests > 0 ? (passedTests / totalTests * 100).toFixed(1) : 0;\n\n        console.log(`📊 Overall: ${passedTests}/${totalTests} passed (${successRate}%)`);\n        console.log('');\n\n        for (const [name, result] of Object.entries(this.results)) {\n            const status = result.success ? '✅' : '❌';\n            console.log(`${status} ${name}`);\n            \n            if (!result.success && result.error && result.error !== 'TIMEOUT') {\n                console.log(`   └─ ${result.error.split('\\n')[0]}`);\n            }\n        }\n\n        console.log('');\n        if (passedTests === totalTests) {\n            console.log('🎉 ALL DEMOS WORKING! System is ready for production!');\n        } else {\n            console.log(`⚠️  ${totalTests - passedTests} demos need attention`);\n        }\n\n        // Save detailed results\n        fs.writeFileSync('demo-test-results.json', JSON.stringify(this.results, null, 2));\n        console.log('📄 Detailed results saved to demo-test-results.json');\n    }\n}\n\n// Run the tests\nasync function main() {\n    const tester = new DemoTester();\n    await tester.runAllTests();\n}\n\nif (require.main === module) {\n    main().catch(console.error);\n}\n\nmodule.exports = { DemoTester };"