/**
 * @fileoverview Signer allocation and management utility
 * @module SignerManager
 * @description Manages allocation of Ethereum signers for the demo, ensuring
 * system roles (owner, fee wallet, KYC/AML issuers) are reserved and user/investor
 * signers are allocated intelligently without conflicts.
 * 
 * @example
 * const SignerManager = require('./utils/SignerManager');
 * const manager = new SignerManager(demoState);
 * const result = manager.getNextAvailableSigner('investor', 'Alice');
 * console.log(`Allocated signer[${result.index}] to Alice`);
 */

/**
 * @class SignerManager
 * @description Manages signer allocation for the demo system.
 * Reserves signers[0-3] for system roles and allocates signers[4+] for users/investors.
 */
class SignerManager {
    /**
     * Create a SignerManager
     * @param {Object} state - DemoState instance
     */
    constructor(state) {
        /**
         * @property {Object} state - Reference to DemoState
         * @private
         */
        this.state = state;
    }

    /**
     * Get next available signer for investor or user
     * Skips reserved signers (0-3) and already allocated signers
     * 
     * @param {string} type - 'investor' or 'user'
     * @param {string} name - Name of the investor/user
     * @returns {Object|null} {signer, index} or null if no signers available
     * 
     * @example
     * const result = manager.getNextAvailableSigner('investor', 'Alice');
     * if (result) {
     *   console.log(`Allocated signer[${result.index}]: ${result.signer.address}`);
     * } else {
     *   console.log('No signers available');
     * }
     */
    getNextAvailableSigner(type, name) {
        // Find next available signer
        while (this.state.nextAvailableSignerIndex < this.state.signers.length) {
            const index = this.state.nextAvailableSignerIndex;

            // Check if this signer is already allocated
            if (!this.state.allocatedSigners.has(index) && !this.state.reservedSigners.has(index)) {
                // Allocate this signer
                this.state.allocatedSigners.set(index, { type, name });
                this.state.nextAvailableSignerIndex++;

                return {
                    signer: this.state.signers[index],
                    index: index
                };
            }

            this.state.nextAvailableSignerIndex++;
        }

        // No more signers available
        return null;
    }

    /**
     * Get reserved signer information for display
     * 
     * @returns {Array<Object>} Array of reserved signer info objects
     * 
     * @example
     * const reserved = manager.getReservedSignersInfo();
     * reserved.forEach(info => {
     *   console.log(`[${info.index}] ${info.role}: ${info.address}`);
     * });
     */
    getReservedSignersInfo() {
        return [
            { 
                index: 0, 
                role: 'Platform Owner (Deployer)', 
                address: this.state.signers[0]?.address 
            },
            { 
                index: 1, 
                role: 'Owner Fee Wallet (2% fees)', 
                address: this.state.signers[1]?.address 
            },
            { 
                index: 2, 
                role: 'KYC Issuer', 
                address: this.state.signers[2]?.address 
            },
            { 
                index: 3, 
                role: 'AML Issuer', 
                address: this.state.signers[3]?.address 
            }
        ];
    }

    /**
     * Display signer allocation status to console
     * Shows reserved signers, allocated signers, and available count
     * 
     * @example
     * manager.displaySignerAllocation();
     * // Output:
     * // 📊 SIGNER ALLOCATION STATUS
     * // ============================================================
     * // 🔒 RESERVED SIGNERS (System Roles):
     * //    [0] Platform Owner (Deployer)
     * //        0x1234...
     * // ...
     */
    displaySignerAllocation() {
        console.log('\n📊 SIGNER ALLOCATION STATUS');
        console.log('='.repeat(60));

        console.log('\n🔒 RESERVED SIGNERS (System Roles):');
        this.getReservedSignersInfo().forEach(info => {
            console.log(`   [${info.index}] ${info.role}`);
            console.log(`       ${info.address}`);
        });

        console.log('\n👥 ALLOCATED SIGNERS (Users/Investors):');
        if (this.state.allocatedSigners.size === 0) {
            console.log('   None allocated yet');
        } else {
            for (const [index, allocation] of this.state.allocatedSigners.entries()) {
                console.log(`   [${index}] ${allocation.type.toUpperCase()}: ${allocation.name}`);
                console.log(`       ${this.state.signers[index].address}`);
            }
        }

        const availableCount = this.state.signers.length - this.state.reservedSigners.size - this.state.allocatedSigners.size;
        console.log(`\n✅ Available Signers: ${availableCount} (signers[${this.state.nextAvailableSignerIndex}] onwards)`);
    }

    /**
     * Get a specific reserved signer by role
     * 
     * @param {string} role - Role name: 'owner', 'feeWallet', 'kycIssuer', or 'amlIssuer'
     * @returns {Object|null} Signer object or null if not found
     * 
     * @example
     * const owner = manager.getReservedSigner('owner');
     * const kycIssuer = manager.getReservedSigner('kycIssuer');
     */
    getReservedSigner(role) {
        const roleMap = {
            'owner': 0,
            'feeWallet': 1,
            'kycIssuer': 2,
            'amlIssuer': 3
        };

        const index = roleMap[role];
        if (index !== undefined && this.state.signers[index]) {
            return this.state.signers[index];
        }

        return null;
    }

    /**
     * Get allocation info for a specific signer index
     * 
     * @param {number} index - Signer index
     * @returns {Object|null} Allocation info {type, name} or null if not allocated
     * 
     * @example
     * const info = manager.getAllocationInfo(5);
     * if (info) {
     *   console.log(`Signer[5] is allocated to ${info.type}: ${info.name}`);
     * }
     */
    getAllocationInfo(index) {
        return this.state.allocatedSigners.get(index) || null;
    }

    /**
     * Check if a signer index is reserved
     * 
     * @param {number} index - Signer index
     * @returns {boolean} True if reserved
     * 
     * @example
     * if (manager.isReserved(0)) {
     *   console.log('Signer[0] is reserved for platform owner');
     * }
     */
    isReserved(index) {
        return this.state.reservedSigners.has(index);
    }

    /**
     * Check if a signer index is allocated
     * 
     * @param {number} index - Signer index
     * @returns {boolean} True if allocated
     * 
     * @example
     * if (manager.isAllocated(5)) {
     *   const info = manager.getAllocationInfo(5);
     *   console.log(`Signer[5] is allocated to ${info.name}`);
     * }
     */
    isAllocated(index) {
        return this.state.allocatedSigners.has(index);
    }

    /**
     * Get count of available signers
     * 
     * @returns {number} Number of available signers
     * 
     * @example
     * const available = manager.getAvailableCount();
     * console.log(`${available} signers available for allocation`);
     */
    getAvailableCount() {
        return this.state.signers.length - this.state.reservedSigners.size - this.state.allocatedSigners.size;
    }

    /**
     * Reset signer allocation (for testing purposes)
     * Clears all allocated signers and resets the next available index
     * 
     * @example
     * manager.resetAllocation();
     * console.log('All signer allocations cleared');
     */
    resetAllocation() {
        this.state.allocatedSigners.clear();
        this.state.nextAvailableSignerIndex = 4;
    }
}

module.exports = SignerManager;

