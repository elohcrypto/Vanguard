/**
 * @fileoverview Input validation utilities
 * @module ValidationHelpers
 * @description Provides validation functions for user inputs, addresses,
 * amounts, and other data types used throughout the demo.
 * 
 * @example
 * const { isValidAddress, isValidAmount } = require('./utils/ValidationHelpers');
 * if (isValidAddress(address)) {
 *   console.log('Valid Ethereum address');
 * }
 */

const { ethers } = require('hardhat');

/**
 * Check if a string is a valid Ethereum address
 * 
 * @param {string} address - Address to validate
 * @returns {boolean} True if valid address
 * 
 * @example
 * if (isValidAddress('0x1234...')) {
 *   console.log('Valid address');
 * }
 */
function isValidAddress(address) {
    try {
        return ethers.isAddress(address);
    } catch (error) {
        return false;
    }
}

/**
 * Check if a value is a valid positive number
 * 
 * @param {any} value - Value to validate
 * @returns {boolean} True if valid positive number
 * 
 * @example
 * if (isValidAmount('100')) {
 *   console.log('Valid amount');
 * }
 */
function isValidAmount(value) {
    const num = Number(value);
    return !isNaN(num) && num > 0 && isFinite(num);
}

/**
 * Check if a value is a valid non-negative number
 * 
 * @param {any} value - Value to validate
 * @returns {boolean} True if valid non-negative number
 * 
 * @example
 * if (isValidNonNegativeNumber('0')) {
 *   console.log('Valid non-negative number');
 * }
 */
function isValidNonNegativeNumber(value) {
    const num = Number(value);
    return !isNaN(num) && num >= 0 && isFinite(num);
}

/**
 * Check if a value is a valid integer
 * 
 * @param {any} value - Value to validate
 * @returns {boolean} True if valid integer
 * 
 * @example
 * if (isValidInteger('42')) {
 *   console.log('Valid integer');
 * }
 */
function isValidInteger(value) {
    const num = Number(value);
    return !isNaN(num) && Number.isInteger(num);
}

/**
 * Check if a value is within a range
 * 
 * @param {number} value - Value to check
 * @param {number} min - Minimum value (inclusive)
 * @param {number} max - Maximum value (inclusive)
 * @returns {boolean} True if within range
 * 
 * @example
 * if (isInRange(50, 0, 100)) {
 *   console.log('Value is within range');
 * }
 */
function isInRange(value, min, max) {
    const num = Number(value);
    return !isNaN(num) && num >= min && num <= max;
}

/**
 * Check if a string is not empty
 * 
 * @param {string} str - String to validate
 * @returns {boolean} True if not empty
 * 
 * @example
 * if (isNotEmpty(userInput)) {
 *   console.log('Input provided');
 * }
 */
function isNotEmpty(str) {
    return typeof str === 'string' && str.trim().length > 0;
}

/**
 * Check if a value is a valid choice from options
 * 
 * @param {string} value - Value to check
 * @param {Array<string>} options - Valid options
 * @returns {boolean} True if valid choice
 * 
 * @example
 * if (isValidChoice(choice, ['1', '2', '3'])) {
 *   console.log('Valid menu choice');
 * }
 */
function isValidChoice(value, options) {
    return options.includes(value);
}

/**
 * Validate and parse a number input
 * 
 * @param {string} input - Input string
 * @param {Object} [options] - Validation options
 * @param {number} [options.min] - Minimum value
 * @param {number} [options.max] - Maximum value
 * @param {boolean} [options.integer=false] - Require integer
 * @returns {Object} {valid: boolean, value: number|null, error: string|null}
 * 
 * @example
 * const result = validateNumber('100', { min: 0, max: 1000 });
 * if (result.valid) {
 *   console.log(`Valid number: ${result.value}`);
 * } else {
 *   console.log(`Error: ${result.error}`);
 * }
 */
function validateNumber(input, options = {}) {
    const { min, max, integer = false } = options;
    
    const num = Number(input);
    
    if (isNaN(num)) {
        return { valid: false, value: null, error: 'Not a valid number' };
    }
    
    if (!isFinite(num)) {
        return { valid: false, value: null, error: 'Number must be finite' };
    }
    
    if (integer && !Number.isInteger(num)) {
        return { valid: false, value: null, error: 'Must be an integer' };
    }
    
    if (min !== undefined && num < min) {
        return { valid: false, value: null, error: `Must be at least ${min}` };
    }
    
    if (max !== undefined && num > max) {
        return { valid: false, value: null, error: `Must be at most ${max}` };
    }
    
    return { valid: true, value: num, error: null };
}

/**
 * Validate an Ethereum address input
 * 
 * @param {string} input - Address input
 * @returns {Object} {valid: boolean, address: string|null, error: string|null}
 * 
 * @example
 * const result = validateAddress(userInput);
 * if (result.valid) {
 *   console.log(`Valid address: ${result.address}`);
 * }
 */
function validateAddress(input) {
    if (!input || typeof input !== 'string') {
        return { valid: false, address: null, error: 'Address is required' };
    }
    
    const trimmed = input.trim();
    
    if (!isValidAddress(trimmed)) {
        return { valid: false, address: null, error: 'Invalid Ethereum address format' };
    }
    
    return { valid: true, address: trimmed, error: null };
}

/**
 * Validate a yes/no input
 * 
 * @param {string} input - User input
 * @returns {Object} {valid: boolean, value: boolean|null, error: string|null}
 * 
 * @example
 * const result = validateYesNo(userInput);
 * if (result.valid) {
 *   if (result.value) {
 *     console.log('User said yes');
 *   }
 * }
 */
function validateYesNo(input) {
    if (!input || typeof input !== 'string') {
        return { valid: false, value: null, error: 'Input is required' };
    }
    
    const normalized = input.trim().toLowerCase();
    
    if (['y', 'yes'].includes(normalized)) {
        return { valid: true, value: true, error: null };
    }
    
    if (['n', 'no'].includes(normalized)) {
        return { valid: true, value: false, error: null };
    }
    
    return { valid: false, value: null, error: 'Please enter yes/no or y/n' };
}

/**
 * Sanitize a string input
 * 
 * @param {string} input - Input string
 * @param {Object} [options] - Sanitization options
 * @param {number} [options.maxLength] - Maximum length
 * @param {boolean} [options.trim=true] - Trim whitespace
 * @returns {string} Sanitized string
 * 
 * @example
 * const clean = sanitizeString(userInput, { maxLength: 50, trim: true });
 */
function sanitizeString(input, options = {}) {
    const { maxLength, trim = true } = options;
    
    let result = String(input);
    
    if (trim) {
        result = result.trim();
    }
    
    if (maxLength && result.length > maxLength) {
        result = result.substring(0, maxLength);
    }
    
    return result;
}

/**
 * Validate a country code (ISO 3166-1 numeric)
 * 
 * @param {any} code - Country code to validate
 * @returns {boolean} True if valid country code
 * 
 * @example
 * if (isValidCountryCode(840)) {
 *   console.log('Valid country code (USA)');
 * }
 */
function isValidCountryCode(code) {
    const num = Number(code);
    return !isNaN(num) && Number.isInteger(num) && num >= 0 && num <= 999;
}

/**
 * Validate a tier level (1-5)
 * 
 * @param {any} tier - Tier to validate
 * @returns {boolean} True if valid tier
 * 
 * @example
 * if (isValidTier(3)) {
 *   console.log('Valid tier level');
 * }
 */
function isValidTier(tier) {
    const num = Number(tier);
    return !isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 5;
}

module.exports = {
    isValidAddress,
    isValidAmount,
    isValidNonNegativeNumber,
    isValidInteger,
    isInRange,
    isNotEmpty,
    isValidChoice,
    validateNumber,
    validateAddress,
    validateYesNo,
    sanitizeString,
    isValidCountryCode,
    isValidTier
};

