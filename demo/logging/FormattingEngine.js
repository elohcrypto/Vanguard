/**
 * FormattingEngine - Format and display blockchain data
 */
class FormattingEngine {
    constructor() {
        this.colors = {
            reset: '\\x1b[0m',
            bright: '\\x1b[1m',
            red: '\\x1b[31m',
            green: '\\x1b[32m',
            yellow: '\\x1b[33m',
            blue: '\\x1b[34m',
            magenta: '\\x1b[35m',
            cyan: '\\x1b[36m',
            white: '\\x1b[37m'
        };
    }

    /**
     * Format contract addresses with labels
     */
    formatAddress(address, label = '') {
        if (!address) return 'N/A';

        const shortAddress = `${address.substring(0, 6)}...${address.substring(38)}`;
        const fullDisplay = label ? `${label}: ${address}` : address;

        return {
            full: fullDisplay,
            short: label ? `${label}: ${shortAddress}` : shortAddress,
            address: address
        };
    }

    /**
     * Format transaction hashes
     */
    formatTxHash(hash) {
        if (!hash) return 'N/A';

        return {
            full: hash,
            short: `${hash.substring(0, 10)}...${hash.substring(58)}`,
            hash: hash
        };
    }

    /**
     * Format amounts with proper units and decimals
     */
    formatAmount(amount, decimals = 18, symbol = 'ETH') {
        if (!amount) return '0';

        try {
            const value = typeof amount === 'bigint' ? amount : BigInt(amount);
            const divisor = BigInt(10 ** decimals);
            const wholePart = value / divisor;
            const fractionalPart = value % divisor;

            const formatted = `${wholePart.toString()}.${fractionalPart.toString().padStart(decimals, '0').substring(0, 6)}`;

            return {
                formatted: `${formatted} ${symbol}`,
                value: formatted,
                symbol: symbol,
                raw: amount.toString()
            };
        } catch (error) {
            return {
                formatted: `${amount} ${symbol}`,
                value: amount.toString(),
                symbol: symbol,
                raw: amount.toString()
            };
        }
    }

    /**
     * Format timestamps in human-readable format
     */
    formatTimestamp(timestamp) {
        try {
            const date = new Date(timestamp * 1000);
            return {
                iso: date.toISOString(),
                local: date.toLocaleString(),
                relative: this.getRelativeTime(date),
                timestamp: timestamp
            };
        } catch (error) {
            return {
                iso: new Date().toISOString(),
                local: new Date().toLocaleString(),
                relative: 'now',
                timestamp: timestamp
            };
        }
    }

    /**
     * Get relative time string
     */
    getRelativeTime(date) {
        const now = new Date();
        const diffMs = now - date;
        const diffSecs = Math.floor(diffMs / 1000);
        const diffMins = Math.floor(diffSecs / 60);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffSecs < 60) return `${diffSecs}s ago`;
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${diffDays}d ago`;
    }

    /**
     * Create structured tables for complex data
     */
    formatTable(headers, rows, options = {}) {
        const { maxWidth = 120, padding = 2 } = options;

        if (!headers || !rows || rows.length === 0) {
            return 'No data to display';
        }

        // Calculate column widths
        const colWidths = headers.map((header, index) => {
            const headerWidth = header.length;
            const maxRowWidth = Math.max(...rows.map(row =>
                String(row[index] || '').length
            ));
            return Math.min(Math.max(headerWidth, maxRowWidth) + padding,
                Math.floor(maxWidth / headers.length));
        });

        // Create separator
        const separator = '+' + colWidths.map(width => '-'.repeat(width)).join('+') + '+';

        // Format header
        const headerRow = '|' + headers.map((header, index) =>
            this.padString(header, colWidths[index])
        ).join('|') + '|';

        // Format rows
        const dataRows = rows.map(row =>
            '|' + row.map((cell, index) =>
                this.padString(String(cell || ''), colWidths[index])
            ).join('|') + '|'
        );

        return [separator, headerRow, separator, ...dataRows, separator].join('\\n');
    }

    /**
     * Pad string to specified width
     */
    padString(str, width) {
        if (str.length >= width) {
            return str.substring(0, width - 3) + '...';
        }
        return ' ' + str + ' '.repeat(width - str.length - 1);
    }

    /**
     * Format events with proper indentation
     */
    formatEvents(events) {
        if (!events || events.length === 0) {
            return 'No events emitted';
        }

        let output = `\\n🎉 Events Emitted (${events.length}):\\n`;

        events.forEach((event, index) => {
            output += `\\n   Event ${index + 1}:\\n`;
            output += `     Address: ${event.address}\\n`;
            output += `     Topics: ${event.topics?.length || 0}\\n`;

            if (event.decoded) {
                output += `     Event Name: ${event.decoded.eventName}\\n`;
                output += `     Contract: ${event.decoded.contractName}\\n`;

                if (event.decoded.args && Object.keys(event.decoded.args).length > 0) {
                    output += `     Parameters:\\n`;
                    Object.entries(event.decoded.args).forEach(([key, value]) => {
                        output += `       ${key}: ${this.formatValue(value)}\\n`;
                    });
                }
            } else {
                output += `     Data: ${event.data?.substring(0, 42)}...\\n`;
            }
        });

        return output;
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
                return this.formatAddress(value).short;
            }
            if (value.length === 66) {
                return this.formatTxHash(value).short;
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
     * Create section header
     */
    createSectionHeader(title, emoji = '📋', width = 80) {
        const separator = '='.repeat(width);
        const titleLine = `${emoji} ${title}`;

        return `\\n${separator}\\n${titleLine}\\n${separator}`;
    }

    /**
     * Create subsection header
     */
    createSubsectionHeader(title, emoji = '📌', width = 60) {
        const separator = '-'.repeat(width);
        const titleLine = `${emoji} ${title}`;

        return `\\n${titleLine}\\n${separator}`;
    }

    /**
     * Format contract deployment summary
     */
    formatDeploymentSummary(deployments) {
        if (!deployments || deployments.size === 0) {
            return 'No contracts deployed';
        }

        let output = this.createSectionHeader('DEPLOYMENT SUMMARY', '📦', 80);
        output += `\\n\\n📊 Total Contracts Deployed: ${deployments.size}\\n`;

        // Calculate total gas used
        let totalGas = 0;
        deployments.forEach(info => {
            totalGas += Number(info.gasUsed || 0);
        });
        output += `⛽ Total Gas Used: ${totalGas.toLocaleString()}\\n`;

        output += '\\n' + '─'.repeat(80) + '\\n';
        output += '\\n📋 CONTRACT DETAILS:\\n';

        // Display each contract with better formatting
        let index = 1;
        deployments.forEach((info, name) => {
            output += `\\n${index}. 📦 ${name}\\n`;
            output += `   🔗 Address: ${info.contractAddress}\\n`;
            output += `   🧱 Block: ${info.blockNumber || 'N/A'}\\n`;
            output += `   ⛽ Gas Used: ${Number(info.gasUsed).toLocaleString()}\\n`;
            output += `   ${info.status === 'SUCCESS' ? '✅' : '❌'} Status: ${info.status}\\n`;
            index++;
        });

        output += '\\n' + '─'.repeat(80) + '\\n';

        return output;
    }

    /**
     * Format transaction summary
     */
    formatTransactionSummary(transactions) {
        if (!transactions || transactions.length === 0) {
            return 'No transactions executed';
        }

        let output = this.createSectionHeader('TRANSACTION SUMMARY', '🔄', 80);
        output += `\\n\\n📊 Total Transactions: ${transactions.length}\\n`;

        const successful = transactions.filter(tx => tx.status === 'SUCCESS').length;
        const failed = transactions.filter(tx => tx.status === 'FAILED').length;
        const successRate = transactions.length > 0 ? ((successful / transactions.length) * 100).toFixed(1) : 0;

        output += `✅ Successful: ${successful} (${successRate}%)\\n`;
        output += `❌ Failed: ${failed}\\n`;

        // Calculate total gas
        const totalGas = transactions.reduce((sum, tx) => sum + Number(tx.gasUsed || 0), 0);
        output += `⛽ Total Gas Used: ${totalGas.toLocaleString()}\\n`;

        output += '\\n' + '─'.repeat(80) + '\\n';
        output += '\\n📋 RECENT TRANSACTIONS (Last 10):\\n';

        // Display recent transactions with better formatting
        const recentTxs = transactions.slice(-10);
        recentTxs.forEach((tx, index) => {
            output += `\\n${index + 1}. ${tx.status === 'SUCCESS' ? '✅' : '❌'} ${tx.name || 'Unknown Operation'}\\n`;
            output += `   🔗 Hash: ${tx.transactionHash ? this.formatTxHash(tx.transactionHash).short : 'N/A'}\\n`;
            output += `   🧱 Block: ${tx.blockNumber || 'N/A'}\\n`;
            output += `   ⛽ Gas Used: ${tx.gasUsed ? Number(tx.gasUsed).toLocaleString() : 'N/A'}\\n`;
        });

        output += '\\n' + '─'.repeat(80) + '\\n';

        return output;
    }

    /**
     * Format gas usage statistics
     */
    formatGasStatistics(transactions) {
        if (!transactions || transactions.length === 0) {
            return 'No gas data available';
        }

        const gasUsages = transactions
            .filter(tx => tx.gasUsed)
            .map(tx => Number(tx.gasUsed));

        if (gasUsages.length === 0) {
            return 'No gas usage data available';
        }

        const totalGas = gasUsages.reduce((sum, gas) => sum + gas, 0);
        const avgGas = Math.floor(totalGas / gasUsages.length);
        const maxGas = Math.max(...gasUsages);
        const minGas = Math.min(...gasUsages);

        let output = this.createSectionHeader('GAS USAGE STATISTICS', '⛽', 80);
        output += '\\n\\n📊 GAS METRICS:\\n';
        output += '\\n' + '─'.repeat(80) + '\\n';
        output += `\\n💰 Total Gas Used:     ${totalGas.toLocaleString()} gas\\n`;
        output += `📊 Average Gas:        ${avgGas.toLocaleString()} gas\\n`;
        output += `📈 Maximum Gas:        ${maxGas.toLocaleString()} gas\\n`;
        output += `📉 Minimum Gas:        ${minGas.toLocaleString()} gas\\n`;
        output += `🔢 Transactions:       ${gasUsages.length}\\n`;

        // Estimate cost (assuming 20 gwei gas price)
        const gasPriceGwei = 20;
        const totalCostEth = (totalGas * gasPriceGwei) / 1e9;
        const avgCostEth = (avgGas * gasPriceGwei) / 1e9;

        output += '\\n💵 ESTIMATED COST (@ 20 gwei):\\n';
        output += `   Total: ${totalCostEth.toFixed(6)} ETH\\n`;
        output += `   Average: ${avgCostEth.toFixed(6)} ETH\\n`;

        output += '\\n' + '─'.repeat(80) + '\\n';

        return output;
    }

    /**
     * Apply color to text (if supported)
     */
    colorize(text, color) {
        if (process.stdout.isTTY && this.colors[color]) {
            return `${this.colors[color]}${text}${this.colors.reset}`;
        }
        return text;
    }

    /**
     * Format success message
     */
    formatSuccess(message) {
        return this.colorize(`✅ ${message}`, 'green');
    }

    /**
     * Format error message
     */
    formatError(message) {
        return this.colorize(`❌ ${message}`, 'red');
    }

    /**
     * Format warning message
     */
    formatWarning(message) {
        return this.colorize(`⚠️  ${message}`, 'yellow');
    }

    /**
     * Format info message
     */
    formatInfo(message) {
        return this.colorize(`ℹ️  ${message}`, 'blue');
    }
}

module.exports = FormattingEngine;