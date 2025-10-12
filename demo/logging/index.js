/**
 * Enhanced Logging System - Main Export
 */

const TransactionLogger = require('./TransactionLogger');
const MetadataExtractor = require('./MetadataExtractor');
const FormattingEngine = require('./FormattingEngine');

/**
 * Enhanced Logger - Combines all logging functionality
 */
class EnhancedLogger {
    constructor() {
        this.transactionLogger = new TransactionLogger();
        this.metadataExtractor = new MetadataExtractor();
        this.formattingEngine = new FormattingEngine();
    }

    /**
     * Initialize with provider
     */
    initialize(provider) {
        this.metadataExtractor.setProvider(provider);
    }

    /**
     * Log contract deployment with enhanced metadata
     */
    async logContractDeployment(contractName, contract, constructorArgs = []) {
        return await this.transactionLogger.logContractDeployment(
            contractName,
            contract,
            constructorArgs
        );
    }

    /**
     * Log transaction with enhanced metadata
     */
    async logTransaction(txName, txPromise, inputParams = {}, context = {}) {
        return await this.transactionLogger.logTransaction(
            txName,
            txPromise,
            inputParams,
            context
        );
    }

    /**
     * Log function call
     */
    logFunctionCall(contractName, functionName, inputs = {}, outputs = null) {
        return this.transactionLogger.logFunctionCall(
            contractName,
            functionName,
            inputs,
            outputs
        );
    }

    /**
     * Get deployment summary
     */
    getDeploymentSummary() {
        return this.transactionLogger.getDeploymentSummary();
    }

    /**
     * Get transaction history
     */
    getTransactionHistory() {
        return this.transactionLogger.getTransactionHistory();
    }

    /**
     * Get deployed contracts
     */
    getDeployedContracts() {
        return this.transactionLogger.getDeployedContracts();
    }

    /**
     * Format deployment summary
     */
    formatDeploymentSummary() {
        const deployments = this.transactionLogger.getDeployedContracts();
        return this.formattingEngine.formatDeploymentSummary(deployments);
    }

    /**
     * Format transaction summary
     */
    formatTransactionSummary() {
        const transactions = this.transactionLogger.getTransactionHistory();
        return this.formattingEngine.formatTransactionSummary(transactions);
    }

    /**
     * Format gas statistics
     */
    formatGasStatistics() {
        const transactions = this.transactionLogger.getTransactionHistory();
        return this.formattingEngine.formatGasStatistics(transactions);
    }

    /**
     * Display comprehensive summary
     */
    displayComprehensiveSummary() {
        console.log(this.formatDeploymentSummary());
        console.log(this.formatTransactionSummary());
        console.log(this.formatGasStatistics());
    }
}

module.exports = {
    EnhancedLogger,
    TransactionLogger,
    MetadataExtractor,
    FormattingEngine
};