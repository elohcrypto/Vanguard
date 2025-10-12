#!/usr/bin/env node

/**
 * Reset and Demo Script
 * Kills existing processes, starts fresh Hardhat node, and runs demo
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const { ethers } = require('ethers');

const execAsync = promisify(exec);

async function resetAndDemo() {
    console.log('🧹 Resetting OnchainID Demo Environment');
    console.log('='.repeat(50));

    // Step 1: Kill existing processes
    console.log('🛑 Killing existing processes...');
    try {
        await execAsync('pkill -f "hardhat node"');
        await execAsync('pkill -f "node.*demo"');
    } catch (error) {
        // Ignore errors if no processes to kill
    }

    // Step 2: Clean Hardhat cache
    console.log('🧹 Cleaning Hardhat cache...');
    try {
        await execAsync('npx hardhat clean');
        await execAsync('npx hardhat compile');
    } catch (error) {
        console.log(`⚠️  Warning: ${error.message}`);
    }

    // Step 3: Start fresh Hardhat node
    console.log('🚀 Starting fresh Hardhat node...');
    const hardhatNode = spawn('npx', ['hardhat', 'node'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd()
    });

    let nodeReady = false;

    hardhatNode.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output.trim());

        if (output.includes('Started HTTP and WebSocket JSON-RPC server')) {
            nodeReady = true;
            console.log('\n✅ Hardhat node is ready!');

            // Wait a moment then start demo
            setTimeout(async () => {
                console.log('\n🎯 Starting Demo...');
                console.log('='.repeat(50));

                // Test connection first
                try {
                    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
                    const network = await provider.getNetwork();
                    const blockNumber = await provider.getBlockNumber();

                    console.log(`✅ Connected to network: ${network.name} (Chain ID: ${network.chainId})`);
                    console.log(`📦 Block Number: ${blockNumber}`);

                    // Start the demo
                    const demo = spawn('node', ['demo/standalone-demo.js'], {
                        stdio: 'inherit',
                        cwd: process.cwd()
                    });

                    demo.on('close', (code) => {
                        console.log('\n👋 Demo completed!');
                        console.log('🛑 Stopping Hardhat node...');
                        hardhatNode.kill();
                        process.exit(code);
                    });

                } catch (error) {
                    console.log(`❌ Connection test failed: ${error.message}`);
                    hardhatNode.kill();
                    process.exit(1);
                }

            }, 3000); // Wait 3 seconds for node to fully initialize
        }
    });

    hardhatNode.stderr.on('data', (data) => {
        console.error(`Hardhat Error: ${data}`);
    });

    hardhatNode.on('close', (code) => {
        if (!nodeReady) {
            console.log('❌ Failed to start Hardhat node');
            process.exit(1);
        }
    });

    // Handle cleanup
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down...');
        hardhatNode.kill();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        hardhatNode.kill();
        process.exit(0);
    });
}

resetAndDemo().catch(console.error);