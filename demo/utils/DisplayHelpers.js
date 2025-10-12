/**
 * @fileoverview Display and formatting utilities for console output
 * @module DisplayHelpers
 * @description Provides reusable functions for formatting and displaying
 * information in the console with consistent styling and structure.
 * 
 * @example
 * const { displaySection, displaySuccess, displayError } = require('./utils/DisplayHelpers');
 * displaySection('Deployment');
 * displaySuccess('Contract deployed successfully');
 */

/**
 * Display a section header
 * 
 * @param {string} title - Section title
 * @param {string} [emoji='📋'] - Optional emoji prefix
 * 
 * @example
 * displaySection('Contract Deployment', '🏗️');
 * // Output:
 * // 
 * // 🏗️ CONTRACT DEPLOYMENT
 * // ==================================================
 */
function displaySection(title, emoji = '📋') {
    console.log(`\n${emoji} ${title.toUpperCase()}`);
    console.log('='.repeat(50));
}

/**
 * Display a subsection header
 * 
 * @param {string} title - Subsection title
 * @param {string} [emoji='▶️'] - Optional emoji prefix
 * 
 * @example
 * displaySubsection('Deploying Token Contract', '🪙');
 */
function displaySubsection(title, emoji = '▶️') {
    console.log(`\n${emoji} ${title}`);
    console.log('-'.repeat(40));
}

/**
 * Display a success message
 * 
 * @param {string} message - Success message
 * 
 * @example
 * displaySuccess('Contract deployed at 0x1234...');
 */
function displaySuccess(message) {
    console.log(`✅ ${message}`);
}

/**
 * Display an error message
 * 
 * @param {string} message - Error message
 * 
 * @example
 * displayError('Failed to deploy contract');
 */
function displayError(message) {
    console.log(`❌ ${message}`);
}

/**
 * Display a warning message
 * 
 * @param {string} message - Warning message
 * 
 * @example
 * displayWarning('Gas price is high');
 */
function displayWarning(message) {
    console.log(`⚠️  ${message}`);
}

/**
 * Display an info message
 * 
 * @param {string} message - Info message
 * 
 * @example
 * displayInfo('Processing transaction...');
 */
function displayInfo(message) {
    console.log(`ℹ️  ${message}`);
}

/**
 * Display a key-value pair
 * 
 * @param {string} key - Key name
 * @param {any} value - Value to display
 * @param {number} [indent=0] - Indentation level
 * 
 * @example
 * displayKeyValue('Contract Address', '0x1234...', 1);
 * // Output:
 * //    Contract Address: 0x1234...
 */
function displayKeyValue(key, value, indent = 0) {
    const spaces = '   '.repeat(indent);
    console.log(`${spaces}${key}: ${value}`);
}

/**
 * Display a contract address with label
 * 
 * @param {string} label - Contract label
 * @param {string} address - Contract address
 * 
 * @example
 * displayContractAddress('Token', '0x1234567890abcdef...');
 */
function displayContractAddress(label, address) {
    console.log(`   📄 ${label}: ${address}`);
}

/**
 * Display a transaction hash
 * 
 * @param {string} hash - Transaction hash
 * 
 * @example
 * displayTransactionHash('0xabcdef...');
 */
function displayTransactionHash(hash) {
    console.log(`   🔗 Transaction: ${hash}`);
}

/**
 * Display a separator line
 * 
 * @param {string} [char='='] - Character to use for separator
 * @param {number} [length=50] - Length of separator
 * 
 * @example
 * displaySeparator();
 * displaySeparator('-', 30);
 */
function displaySeparator(char = '=', length = 50) {
    console.log(char.repeat(length));
}

/**
 * Display a table header
 * 
 * @param {Array<string>} columns - Column names
 * @param {Array<number>} [widths] - Column widths (optional)
 * 
 * @example
 * displayTableHeader(['Name', 'Address', 'Balance'], [20, 42, 15]);
 */
function displayTableHeader(columns, widths = null) {
    if (widths) {
        const header = columns.map((col, i) => col.padEnd(widths[i])).join(' | ');
        console.log(header);
        console.log('-'.repeat(header.length));
    } else {
        console.log(columns.join(' | '));
        console.log('-'.repeat(columns.join(' | ').length));
    }
}

/**
 * Display a table row
 * 
 * @param {Array<string>} values - Row values
 * @param {Array<number>} [widths] - Column widths (optional)
 * 
 * @example
 * displayTableRow(['Alice', '0x1234...', '1000'], [20, 42, 15]);
 */
function displayTableRow(values, widths = null) {
    if (widths) {
        const row = values.map((val, i) => String(val).padEnd(widths[i])).join(' | ');
        console.log(row);
    } else {
        console.log(values.join(' | '));
    }
}

/**
 * Display a progress indicator
 * 
 * @param {string} message - Progress message
 * 
 * @example
 * displayProgress('Deploying contracts...');
 */
function displayProgress(message) {
    console.log(`⏳ ${message}`);
}

/**
 * Display a completion message
 * 
 * @param {string} message - Completion message
 * 
 * @example
 * displayComplete('All contracts deployed');
 */
function displayComplete(message) {
    console.log(`✨ ${message}`);
}

/**
 * Display an object in a formatted way
 * 
 * @param {Object} obj - Object to display
 * @param {number} [indent=0] - Indentation level
 * 
 * @example
 * displayObject({ name: 'Alice', balance: 1000 }, 1);
 */
function displayObject(obj, indent = 0) {
    const spaces = '   '.repeat(indent);
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            console.log(`${spaces}${key}:`);
            displayObject(value, indent + 1);
        } else {
            console.log(`${spaces}${key}: ${value}`);
        }
    }
}

/**
 * Display a list of items
 * 
 * @param {Array<string>} items - Items to display
 * @param {string} [bullet='•'] - Bullet character
 * @param {number} [indent=0] - Indentation level
 * 
 * @example
 * displayList(['Item 1', 'Item 2', 'Item 3'], '✓', 1);
 */
function displayList(items, bullet = '•', indent = 0) {
    const spaces = '   '.repeat(indent);
    items.forEach(item => {
        console.log(`${spaces}${bullet} ${item}`);
    });
}

/**
 * Format an Ethereum address for display (shortened)
 * 
 * @param {string} address - Full Ethereum address
 * @param {number} [prefixLength=6] - Length of prefix to show
 * @param {number} [suffixLength=4] - Length of suffix to show
 * @returns {string} Formatted address
 * 
 * @example
 * const short = formatAddress('0x1234567890abcdef1234567890abcdef12345678');
 * console.log(short); // "0x1234...5678"
 */
function formatAddress(address, prefixLength = 6, suffixLength = 4) {
    if (!address || address.length < prefixLength + suffixLength) {
        return address;
    }
    return `${address.slice(0, prefixLength)}...${address.slice(-suffixLength)}`;
}

/**
 * Format a large number with commas
 * 
 * @param {number|string} num - Number to format
 * @returns {string} Formatted number
 * 
 * @example
 * console.log(formatNumber(1000000)); // "1,000,000"
 */
function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format wei to ether
 * 
 * @param {string|number} wei - Wei amount
 * @returns {string} Ether amount
 * 
 * @example
 * console.log(formatWeiToEther('1000000000000000000')); // "1.0 ETH"
 */
function formatWeiToEther(wei) {
    const { ethers } = require('hardhat');
    return `${ethers.formatEther(wei)} ETH`;
}

module.exports = {
    displaySection,
    displaySubsection,
    displaySuccess,
    displayError,
    displayWarning,
    displayInfo,
    displayKeyValue,
    displayContractAddress,
    displayTransactionHash,
    displaySeparator,
    displayTableHeader,
    displayTableRow,
    displayProgress,
    displayComplete,
    displayObject,
    displayList,
    formatAddress,
    formatNumber,
    formatWeiToEther
};

