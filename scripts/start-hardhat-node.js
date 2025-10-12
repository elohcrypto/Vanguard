#!/usr/bin/env node

/**
 * Start Hardhat Local Node
 * Starts a local Hardhat network for testing with proper cleanup
 */

const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

let hardhatNode = null;

async function killProcessOnPort(port) {
    console.log(`🔍 Checking for processes on port ${port}...`);

    try {
        // Find process using port 8545
        const { stdout } = await execAsync(`lsof -ti:${port}`);
        const pids = stdout.trim().split('\n').filter(pid => pid);

        if (pids.length > 0) {
            console.log(`🗑️  Found ${pids.length} process(es) on port ${port}, terminating...`);

            for (const pid of pids) {
                try {
                    await execAsync(`kill -9 ${pid}`);
                    console.log(`   ✅ Killed process ${pid}`);
                } catch (error) {
                    console.log(`   ⚠️  Could not kill process ${pid}: ${error.message}`);
                }
            }

            // Wait a moment for processes to fully terminate
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log(`✅ No processes found on port ${port}`);
        }
    } catch (error) {
        // lsof command failed, likely no processes on port
        console.log(`✅ Port ${port} appears to be free`);
    }
}

async function killHardhatProcesses() {
    console.log('🧹 Cleaning up existing Hardhat processes...');

    try {
        // Kill by process name
        await execAsync('pkill -f "hardhat node" || true');
        await execAsync('pkill -f "npx hardhat node" || true');
        console.log('✅ Hardhat processes cleaned up');
    } catch (error) {
        console.log('⚠️  pkill not available or no processes found');
    }
}

function setupGracefulShutdown() {
    const shutdown = (signal) => {
        console.log(`\n🛑 Received ${signal}, shutting down Hardhat node...`);

        if (hardhatNode) {
            hardhatNode.kill('SIGTERM');

            // Force kill after 5 seconds if still running
            setTimeout(() => {
                if (hardhatNode && !hardhatNode.killed) {
                    console.log('🔥 Force killing Hardhat node...');
                    hardhatNode.kill('SIGKILL');
                }
            }, 5000);
        }

        // Kill any remaining processes on port 8545
        setTimeout(async () => {
            await killProcessOnPort(8545);
            process.exit(0);
        }, 1000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('exit', () => {
        if (hardhatNode && !hardhatNode.killed) {
            hardhatNode.kill('SIGKILL');
        }
    });
}

async function startHardhatNode() {
    console.log('🚀 Starting Hardhat Local Network');
    console.log('='.repeat(50));

    // Step 1: Kill processes on port 8545
    await killProcessOnPort(8545);

    // Step 2: Kill any remaining Hardhat processes
    await killHardhatProcesses();

    // Step 3: Setup graceful shutdown handlers
    setupGracefulShutdown();

    // Step 4: Start Hardhat node
    console.log('🌐 Starting fresh Hardhat node...');

    hardhatNode = spawn('npx', ['hardhat', 'node'], {
        stdio: 'inherit',
        cwd: process.cwd()
    });

    hardhatNode.on('close', (code) => {
        console.log(`\n🛑 Hardhat node stopped with code ${code}`);

        // Clean up port on exit
        killProcessOnPort(8545).then(() => {
            process.exit(code);
        });
    });

    hardhatNode.on('error', (error) => {
        console.log(`❌ Error starting Hardhat node: ${error.message}`);
        process.exit(1);
    });

    console.log('💡 Press Ctrl+C to stop the node');
    console.log('🔗 Node will be available at: http://127.0.0.1:8545');
}

// Start the node
startHardhatNode().catch(console.error);