#!/usr/bin/env node

/**
 * Run Rejection Demo Only
 * This script runs the rejection demo without starting a new Hardhat node
 */

const { spawn } = require('child_process');
const { ethers } = require('ethers');

async function checkHardhatNode() {
    console.log('🔍 Checking if Hardhat node is running...');

    try {
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        const network = await provider.getNetwork();
        const blockNumber = await provider.getBlockNumber();

        console.log('✅ Hardhat node is running!');
        console.log(`   Network: ${network.name} (Chain ID: ${network.chainId})`);
        console.log(`   Block Number: ${blockNumber}`);

        return true;
    } catch (error) {
        console.log('❌ Hardhat node is not running!');
        console.log('💡 Please start it first with: npm run node:start');
        return false;
    }
}

async function runRejectionDemo() {
    const isNodeRunning = await checkHardhatNode();

    if (!isNodeRunning) {
        console.log('\n🚨 Cannot run demo without Hardhat node');
        console.log('📋 To fix this:');
        console.log('   1. Open a new terminal');
        console.log('   2. Run: npm run node:start');
        console.log('   3. Wait for "Started HTTP and WebSocket JSON-RPC server"');
        console.log('   4. Then run this demo again');
        process.exit(1);
    }

    console.log('\n🚫 Starting Rejection Scenarios Demo...');
    console.log('='.repeat(50));

    // Run the rejection demo
    const demo = spawn('node', ['demo/rejection-demo.js'], {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: { ...process.env, HARDHAT_NETWORK: 'localhost' }
    });

    demo.on('close', (code) => {
        console.log('\n👋 Rejection demo completed!');
        process.exit(code);
    });
}

runRejectionDemo().catch(console.error);