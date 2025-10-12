#!/usr/bin/env node

/**
 * Complete Reset Script
 * Kills all processes, cleans state, and starts fresh
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function killAllProcesses() {
    console.log('🧹 Killing all Hardhat and Node processes...');

    try {
        // Kill processes on port 8545
        await execAsync('lsof -ti:8545 | xargs kill -9 || true');
        console.log('✅ Killed processes on port 8545');

        // Kill Hardhat processes
        await execAsync('pkill -f "hardhat node" || true');
        await execAsync('pkill -f "npx hardhat" || true');
        console.log('✅ Killed Hardhat processes');

        // Kill Node processes related to demo
        await execAsync('pkill -f "demo" || true');
        console.log('✅ Killed demo processes');

        // Wait for cleanup
        await new Promise(resolve => setTimeout(resolve, 2000));

    } catch (error) {
        console.log('⚠️  Some cleanup commands failed, but continuing...');
    }
}

async function startFreshNode() {
    console.log('🚀 Starting fresh Hardhat node...');

    const hardhatNode = spawn('npx', ['hardhat', 'node'], {
        stdio: 'inherit',
        cwd: process.cwd(),
        detached: false
    });

    // Wait for node to start
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('✅ Hardhat node should be running');
    console.log('🔗 Available at: http://127.0.0.1:8545');

    return hardhatNode;
}

async function main() {
    console.log('🔄 Complete Reset and Fresh Start');
    console.log('='.repeat(50));

    // Step 1: Kill everything
    await killAllProcesses();

    // Step 2: Start fresh node
    const node = await startFreshNode();

    // Step 3: Setup graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down...');
        node.kill();
        process.exit(0);
    });

    console.log('\n💡 Node is ready! In another terminal, run:');
    console.log('   npm run demo:quick    (for automated demo)');
    console.log('   npm run demo:main     (for interactive demo)');
    console.log('\n🛑 Press Ctrl+C to stop the node');
}

main().catch(console.error);