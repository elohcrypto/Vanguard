/**
 * TransactionLogger - Core logging infrastructure for blockchain transactions
 */
class TransactionLogger {
    constructor() {
        this.deployedContracts = new Map();
        this.transactionHistory = [];
        this.eventHistory = [];
        this.startTime = Date.now();
    }

    /**
     * Log contract deployment with full metadata
     */
    async logContractDeployment(contractName, contract, constructorArgs = []) {
        try {
            const address = await contract.getAddress();
            const deploymentTx = contract.deploymentTransaction();

            if (!deploymentTx) {
                console.log(`⚠️  Warning: No deployment transaction found for ${contractName}`);
                return;
            }

            const receipt = await deploymentTx.wait();

            const deploymentInfo = {
                contractName,
                contractAddress: address,
                deployerAddress: deploymentTx.from,
                constructorArgs,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                gasPrice: deploymentTx.gasPrice?.toString() || 'N/A',
                timestamp: new Date().toISOString(),
                status: receipt.status === 1 ? 'SUCCESS' : 'FAILED'
            };

            this.deployedContracts.set(contractName, deploymentInfo);
            this.displayContractDeployment(deploymentInfo);

            return deploymentInfo;
        } catch (error) {
            console.log(`❌ Error logging deployment for ${contractName}:`, error.message);
            return null;
        }
    }

    /**
     * Log transaction execution with metadata
     */
    async logTransaction(txName, txPromise, inputParams = {}, context = {}) {
        try {
            console.log(`\\n🔄 Executing: ${txName}`);
            console.log('⏳ Waiting for transaction...');

            const tx = await txPromise;
            const receipt = await tx.wait();

            const txInfo = {
                name: txName,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
                gasPrice: tx.gasPrice?.toString() || 'N/A',
                from: tx.from,
                to: tx.to,
                value: tx.value?.toString() || '0',
                status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
                timestamp: new Date().toISOString(),
                inputParams,
                context,
                events: this.extractEvents(receipt)
            };

            this.transactionHistory.push(txInfo);
            this.displayTransactionDetails(txInfo);

            return { receipt, txInfo };
        } catch (error) {
            const errorInfo = {
                name: txName,
                status: 'FAILED',
                error: error.message,
                timestamp: new Date().toISOString(),
                inputParams,
                context
            };

            this.transactionHistory.push(errorInfo);
            this.displayTransactionError(errorInfo);
            throw error;
        }
    }

    /**
     * Log function call with parameters and results
     */
    logFunctionCall(contractName, functionName, inputs = {}, outputs = null) {
        const callInfo = {
            contractName,
            functionName,
            inputs,
            outputs,
            timestamp: new Date().toISOString()
        };

        console.log(`\\n📞 Function Call: ${contractName}.${functionName}`);
        console.log('📥 Input Parameters:');
        Object.entries(inputs).forEach(([key, value]) => {
            console.log(`   ${key}: ${this.formatValue(value)}`);
        });

        if (outputs !== null) {
            console.log('📤 Output Results:');
            if (typeof outputs === 'object' && outputs !== null) {
                Object.entries(outputs).forEach(([key, value]) => {
                    console.log(`   ${key}: ${this.formatValue(value)}`);
                });
            } else {
                console.log(`   Result: ${this.formatValue(outputs)}`);
            }
        }

        return callInfo;
    }

    /**
     * Extract events from transaction receipt
     */
    extractEvents(receipt) {
        const events = [];
        if (receipt.logs && receipt.logs.length > 0) {
            receipt.logs.forEach((log, index) => {
                events.push({
                    logIndex: index,
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    blockNumber: log.blockNumber,
                    transactionHash: log.transactionHash
                });
            });
        }
        return events;
    }

    /**
     * Display contract deployment information
     */
    displayContractDeployment(deploymentInfo) {
        console.log('\\n' + '='.repeat(80));
        console.log('📦 CONTRACT DEPLOYMENT SUCCESSFUL');
        console.log('='.repeat(80));
        console.log(`📋 Contract Name: ${deploymentInfo.contractName}`);
        console.log(`📍 Contract Address: ${deploymentInfo.contractAddress}`);
        console.log(`👤 Deployer Address: ${deploymentInfo.deployerAddress}`);
        console.log(`🔗 Transaction Hash: ${deploymentInfo.transactionHash}`);
        console.log(`🧱 Block Number: ${deploymentInfo.blockNumber}`);
        console.log(`⛽ Gas Used: ${Number(deploymentInfo.gasUsed).toLocaleString()}`);
        console.log(`💰 Gas Price: ${deploymentInfo.gasPrice !== 'N/A' ? Number(deploymentInfo.gasPrice).toLocaleString() + ' wei' : 'N/A'}`);
        console.log(`✅ Status: ${deploymentInfo.status}`);
        console.log(`⏰ Timestamp: ${deploymentInfo.timestamp}`);

        if (deploymentInfo.constructorArgs && deploymentInfo.constructorArgs.length > 0) {
            console.log('🔧 Constructor Arguments:');
            deploymentInfo.constructorArgs.forEach((arg, index) => {
                console.log(`   [${index}]: ${this.formatValue(arg)}`);
            });
        }
        console.log('='.repeat(80));
    }

    /**
     * Display transaction details
     */
    displayTransactionDetails(txInfo) {
        console.log('\\n' + '='.repeat(80));
        console.log('✅ TRANSACTION SUCCESSFUL');
        console.log('='.repeat(80));
        console.log(`📋 Operation: ${txInfo.name}`);
        console.log(`🔗 Transaction Hash: ${txInfo.transactionHash}`);
        console.log(`🧱 Block Number: ${txInfo.blockNumber}`);
        console.log(`⛽ Gas Used: ${Number(txInfo.gasUsed).toLocaleString()}`);
        console.log(`💰 Gas Price: ${txInfo.gasPrice !== 'N/A' ? Number(txInfo.gasPrice).toLocaleString() + ' wei' : 'N/A'}`);
        console.log(`📤 From: ${txInfo.from}`);
        console.log(`📥 To: ${txInfo.to}`);
        console.log(`💎 Value: ${txInfo.value} wei`);
        console.log(`✅ Status: ${txInfo.status}`);
        console.log(`⏰ Timestamp: ${txInfo.timestamp}`);

        if (Object.keys(txInfo.inputParams).length > 0) {
            console.log('📥 Input Parameters:');
            Object.entries(txInfo.inputParams).forEach(([key, value]) => {
                console.log(`   ${key}: ${this.formatValue(value)}`);
            });
        }

        if (Object.keys(txInfo.context).length > 0) {
            console.log('🔍 Context:');
            Object.entries(txInfo.context).forEach(([key, value]) => {
                console.log(`   ${key}: ${this.formatValue(value)}`);
            });
        }

        if (txInfo.events && txInfo.events.length > 0) {
            console.log(`🎉 Events Emitted (${txInfo.events.length}):`);
            txInfo.events.forEach((event, index) => {
                console.log(`   Event ${index + 1}:`);
                console.log(`     Address: ${event.address}`);
                console.log(`     Topics: ${event.topics.length}`);
                console.log(`     Data: ${event.data.substring(0, 42)}...`);
            });
        }
        console.log('='.repeat(80));
    }

    /**
     * Display transaction error
     */
    displayTransactionError(errorInfo) {
        console.log('\\n' + '='.repeat(80));
        console.log('❌ TRANSACTION FAILED');
        console.log('='.repeat(80));
        console.log(`📋 Operation: ${errorInfo.name}`);
        console.log(`❌ Error: ${errorInfo.error}`);
        console.log(`⏰ Timestamp: ${errorInfo.timestamp}`);

        if (Object.keys(errorInfo.inputParams).length > 0) {
            console.log('📥 Input Parameters:');
            Object.entries(errorInfo.inputParams).forEach(([key, value]) => {
                console.log(`   ${key}: ${this.formatValue(value)}`);
            });
        }

        if (Object.keys(errorInfo.context).length > 0) {
            console.log('🔍 Context:');
            Object.entries(errorInfo.context).forEach(([key, value]) => {
                console.log(`   ${key}: ${this.formatValue(value)}`);
            });
        }
        console.log('='.repeat(80));
    }

    /**
     * Format values for display
     */
    formatValue(value) {
        if (value === null || value === undefined) {
            return 'null';
        }
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
            return value; // Address
        }
        if (typeof value === 'string' && value.startsWith('0x') && value.length === 66) {
            return value; // Hash
        }
        if (typeof value === 'object') {
            return JSON.stringify(value, null, 2);
        }
        return String(value);
    }

    /**
     * Get deployment summary
     */
    getDeploymentSummary() {
        console.log('\\n' + '='.repeat(80));
        console.log('📊 DEPLOYMENT SUMMARY');
        console.log('='.repeat(80));
        console.log(`📦 Total Contracts Deployed: ${this.deployedContracts.size}`);
        console.log(`🔄 Total Transactions: ${this.transactionHistory.length}`);
        console.log(`⏱️  Session Duration: ${((Date.now() - this.startTime) / 1000).toFixed(2)}s`);

        console.log('\\n📋 Deployed Contracts:');
        this.deployedContracts.forEach((info, name) => {
            console.log(`   ${name}: ${info.contractAddress}`);
        });
        console.log('='.repeat(80));
    }

    /**
     * Get transaction history
     */
    getTransactionHistory() {
        return this.transactionHistory;
    }

    /**
     * Get deployed contracts
     */
    getDeployedContracts() {
        return this.deployedContracts;
    }
}

module.exports = TransactionLogger;