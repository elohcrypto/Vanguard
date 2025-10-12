/**
 * MetadataExtractor - Extract and process blockchain metadata
 */
class MetadataExtractor {
    constructor() {
        this.provider = null;
    }

    setProvider(provider) {
        this.provider = provider;
    }

    /**
     * Extract all relevant data from transaction receipts
     */
    async extractTransactionMetadata(receipt) {
        try {
            const block = await this.provider?.getBlock(receipt.blockNumber);

            return {
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                gasUsed: receipt.gasUsed,
                gasPrice: receipt.gasPrice || 0n,
                status: receipt.status,
                from: receipt.from,
                to: receipt.to,
                value: receipt.value || 0n,
                timestamp: block?.timestamp || Math.floor(Date.now() / 1000),
                confirmations: receipt.confirmations || 0,
                logs: receipt.logs || []
            };
        } catch (error) {
            console.log('⚠️  Warning: Could not extract full metadata:', error.message);
            return {
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed,
                status: receipt.status,
                timestamp: Math.floor(Date.now() / 1000)
            };
        }
    }

    /**
     * Extract contract deployment information
     */
    async extractDeploymentMetadata(receipt, constructorArgs = []) {
        const baseMetadata = await this.extractTransactionMetadata(receipt);

        return {
            ...baseMetadata,
            contractAddress: receipt.contractAddress || receipt.to,
            constructorArgs,
            bytecodeLength: receipt.logs?.length || 0,
            deploymentCost: this.calculateDeploymentCost(receipt)
        };
    }

    /**
     * Extract event data with decoded parameters
     */
    extractEventData(logs, contractInterfaces = {}) {
        const events = [];

        logs.forEach((log, index) => {
            try {
                const eventData = {
                    logIndex: index,
                    address: log.address,
                    topics: log.topics,
                    data: log.data,
                    blockNumber: log.blockNumber,
                    transactionHash: log.transactionHash,
                    decoded: null
                };

                // Try to decode with provided interfaces
                Object.entries(contractInterfaces).forEach(([contractName, contractInterface]) => {
                    try {
                        if (contractInterface && contractInterface.parseLog) {
                            const decoded = contractInterface.parseLog(log);
                            if (decoded) {
                                eventData.decoded = {
                                    contractName,
                                    eventName: decoded.name,
                                    args: this.formatEventArgs(decoded.args)
                                };
                            }
                        }
                    } catch (decodeError) {
                        // Continue trying other interfaces
                    }
                });

                events.push(eventData);
            } catch (error) {
                console.log(`⚠️  Warning: Could not process log ${index}:`, error.message);
            }
        });

        return events;
    }

    /**
     * Format event arguments for display
     */
    formatEventArgs(args) {
        const formatted = {};

        if (args && typeof args === 'object') {
            Object.entries(args).forEach(([key, value]) => {
                if (isNaN(key)) { // Skip numeric indices
                    formatted[key] = this.formatValue(value);
                }
            });
        }

        return formatted;
    }

    /**
     * Extract gas usage and cost information
     */
    extractGasMetadata(receipt) {
        const gasUsed = receipt.gasUsed || 0n;
        const gasPrice = receipt.gasPrice || 0n;
        const gasCost = gasUsed * gasPrice;

        return {
            gasUsed: gasUsed.toString(),
            gasPrice: gasPrice.toString(),
            gasCost: gasCost.toString(),
            gasUsedFormatted: Number(gasUsed).toLocaleString(),
            gasPriceFormatted: Number(gasPrice).toLocaleString() + ' wei',
            gasCostFormatted: this.formatEther(gasCost) + ' ETH'
        };
    }

    /**
     * Extract block and timing information
     */
    async extractBlockMetadata(receipt) {
        try {
            const block = await this.provider?.getBlock(receipt.blockNumber);

            return {
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                timestamp: block?.timestamp || Math.floor(Date.now() / 1000),
                timestampFormatted: new Date((block?.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
                confirmations: receipt.confirmations || 0
            };
        } catch (error) {
            return {
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                timestamp: Math.floor(Date.now() / 1000),
                timestampFormatted: new Date().toISOString(),
                confirmations: 0
            };
        }
    }

    /**
     * Calculate deployment cost
     */
    calculateDeploymentCost(receipt) {
        const gasUsed = receipt.gasUsed || 0n;
        const gasPrice = receipt.gasPrice || 0n;
        return gasUsed * gasPrice;
    }

    /**
     * Format wei to ether
     */
    formatEther(wei) {
        try {
            const ether = Number(wei) / 1e18;
            return ether.toFixed(6);
        } catch (error) {
            return '0.000000';
        }
    }

    /**
     * Format value for display
     */
    formatValue(value) {
        if (value === null || value === undefined) {
            return 'null';
        }
        if (typeof value === 'bigint') {
            return value.toString();
        }
        if (typeof value === 'string' && value.startsWith('0x')) {
            if (value.length === 42) {
                return value; // Address
            }
            if (value.length === 66) {
                return value; // Hash
            }
        }
        if (Array.isArray(value)) {
            return `[${value.map(v => this.formatValue(v)).join(', ')}]`;
        }
        if (typeof value === 'object') {
            return JSON.stringify(value, (key, val) =>
                typeof val === 'bigint' ? val.toString() : val, 2);
        }
        return String(value);
    }

    /**
     * Extract claim metadata
     */
    extractClaimMetadata(claimData) {
        return {
            topic: claimData.topic?.toString() || 'Unknown',
            scheme: claimData.scheme?.toString() || 'Unknown',
            issuer: claimData.issuer || 'Unknown',
            signature: claimData.signature || 'None',
            data: claimData.data || 'None',
            uri: claimData.uri || 'None'
        };
    }

    /**
     * Extract UTXO metadata
     */
    extractUTXOMetadata(utxoData) {
        return {
            utxoId: utxoData.utxoId || 'Unknown',
            value: utxoData.value?.toString() || '0',
            owner: utxoData.owner || 'Unknown',
            scriptPubkey: utxoData.scriptPubkey || 'None',
            complianceHash: utxoData.complianceHash || 'None',
            isValid: utxoData.isValid !== undefined ? utxoData.isValid : 'Unknown'
        };
    }

    /**
     * Extract transfer metadata
     */
    extractTransferMetadata(transferData) {
        return {
            from: transferData.from || 'Unknown',
            to: transferData.to || 'Unknown',
            amount: transferData.amount?.toString() || '0',
            tokenAddress: transferData.tokenAddress || 'Unknown',
            allowed: transferData.allowed !== undefined ? transferData.allowed : 'Unknown',
            reason: transferData.reason || 'None'
        };
    }
}

module.exports = MetadataExtractor;