/**
 * Production Configuration
 * Centralized configuration for production testing and deployment
 */

export interface NetworkConfig {
    name: string;
    chainId: number;
    rpcUrl: string;
    gasPrice: string; // in gwei
    gasLimit: number;
    confirmations: number;
    blockTime: number; // in seconds
}

export interface ProductionConfig {
    // System configuration
    deploymentFee: string; // in ETH
    recoveryTimelock: number; // in seconds
    keyRotationTimelock: number; // in seconds
    claimValidityPeriod: number; // in seconds

    // Claim topics
    topics: {
        kyc: number;
        aml: number;
        investorType: number;
        accreditation: number;
        sanctions: number;
    };

    // Signature schemes
    schemes: {
        ecdsa: number;
        rsa: number;
    };

    // Service providers
    providers: {
        kyc: {
            name: string;
            description: string;
            website: string;
        };
        aml: {
            name: string;
            description: string;
            website: string;
        };
        compliance: {
            name: string;
            description: string;
            website: string;
        };
    };

    // Security settings
    security: {
        maxGasPrice: string; // in gwei
        minConfirmations: number;
        recoveryThreshold: number; // for multi-sig recovery
        keyRotationCooldown: number; // in seconds
    };

    // Performance thresholds
    performance: {
        maxDeploymentTime: number; // in ms
        maxKeyAdditionGas: number;
        maxClaimIssuanceGas: number;
        maxTransactionCostUSD: number;
    };

    // Test data
    testData: {
        individual: {
            fullName: string;
            dateOfBirth: string;
            nationality: string;
            documentType: string;
            address: string;
        };
        corporate: {
            companyName: string;
            jurisdiction: string;
            businessType: string;
            incorporationDate: string;
            registrationNumber: string;
        };
        institutional: {
            institutionName: string;
            institutionType: string;
            aum: string;
            regulatoryLicense: string;
            jurisdiction: string;
        };
    };
}

// Production configuration for different networks
export const PRODUCTION_CONFIGS: { [key: string]: ProductionConfig } = {
    mainnet: {
        deploymentFee: "0.01", // 0.01 ETH
        recoveryTimelock: 48 * 60 * 60, // 48 hours
        keyRotationTimelock: 24 * 60 * 60, // 24 hours
        claimValidityPeriod: 365 * 24 * 60 * 60, // 1 year

        topics: {
            kyc: 6,
            aml: 7,
            investorType: 8,
            accreditation: 9,
            sanctions: 10
        },

        schemes: {
            ecdsa: 1,
            rsa: 2
        },

        providers: {
            kyc: {
                name: "Global KYC Solutions Ltd",
                description: "Enterprise-grade KYC verification service for financial institutions worldwide",
                website: "https://globalkyc.com"
            },
            aml: {
                name: "AML Compliance International",
                description: "Anti-Money Laundering compliance and screening service with global coverage",
                website: "https://amlcompliance.com"
            },
            compliance: {
                name: "Regulatory Compliance Corp",
                description: "Regulatory compliance verification and investor accreditation service",
                website: "https://regcompliance.com"
            }
        },

        security: {
            maxGasPrice: "100", // 100 gwei max
            minConfirmations: 3,
            recoveryThreshold: 2, // 2-of-3 recovery
            keyRotationCooldown: 60 * 60 // 1 hour
        },

        performance: {
            maxDeploymentTime: 60000, // 60 seconds
            maxKeyAdditionGas: 200000, // 200K gas
            maxClaimIssuanceGas: 300000, // 300K gas
            maxTransactionCostUSD: 50 // $50 max per transaction
        },

        testData: {
            individual: {
                fullName: "Alice Johnson",
                dateOfBirth: "1990-05-15",
                nationality: "US",
                documentType: "PASSPORT",
                address: "123 Main St, New York, NY 10001, USA"
            },
            corporate: {
                companyName: "Blockchain Innovations Corp",
                jurisdiction: "Delaware, USA",
                businessType: "Technology",
                incorporationDate: "2020-01-15",
                registrationNumber: "DE123456789"
            },
            institutional: {
                institutionName: "Global Investment Fund",
                institutionType: "INVESTMENT_FUND",
                aum: "500000000", // $500M
                regulatoryLicense: "SEC-IA-123456",
                jurisdiction: "Cayman Islands"
            }
        }
    },

    sepolia: {
        deploymentFee: "0.001", // 0.001 ETH for testnet
        recoveryTimelock: 10 * 60, // 10 minutes for testing
        keyRotationTimelock: 5 * 60, // 5 minutes for testing
        claimValidityPeriod: 30 * 24 * 60 * 60, // 30 days

        topics: {
            kyc: 6,
            aml: 7,
            investorType: 8,
            accreditation: 9,
            sanctions: 10
        },

        schemes: {
            ecdsa: 1,
            rsa: 2
        },

        providers: {
            kyc: {
                name: "Test KYC Provider",
                description: "Test KYC verification service for development",
                website: "https://test-kyc.com"
            },
            aml: {
                name: "Test AML Provider",
                description: "Test AML compliance service for development",
                website: "https://test-aml.com"
            },
            compliance: {
                name: "Test Compliance Provider",
                description: "Test compliance verification service for development",
                website: "https://test-compliance.com"
            }
        },

        security: {
            maxGasPrice: "50", // 50 gwei max for testnet
            minConfirmations: 1,
            recoveryThreshold: 2, // 2-of-3 recovery
            keyRotationCooldown: 5 * 60 // 5 minutes
        },

        performance: {
            maxDeploymentTime: 30000, // 30 seconds
            maxKeyAdditionGas: 200000, // 200K gas
            maxClaimIssuanceGas: 300000, // 300K gas
            maxTransactionCostUSD: 10 // $10 max per transaction
        },

        testData: {
            individual: {
                fullName: "Test User Alice",
                dateOfBirth: "1990-05-15",
                nationality: "US",
                documentType: "PASSPORT",
                address: "123 Test St, Test City, TC 12345, USA"
            },
            corporate: {
                companyName: "Test Corp Inc",
                jurisdiction: "Delaware, USA",
                businessType: "Technology",
                incorporationDate: "2020-01-15",
                registrationNumber: "TEST123456789"
            },
            institutional: {
                institutionName: "Test Investment Fund",
                institutionType: "INVESTMENT_FUND",
                aum: "100000000", // $100M
                regulatoryLicense: "TEST-IA-123456",
                jurisdiction: "Test Jurisdiction"
            }
        }
    },

    hardhat: {
        deploymentFee: "0.01", // 0.01 ETH
        recoveryTimelock: 1, // 1 second for testing
        keyRotationTimelock: 1, // 1 second for testing
        claimValidityPeriod: 365 * 24 * 60 * 60, // 1 year

        topics: {
            kyc: 6,
            aml: 7,
            investorType: 8,
            accreditation: 9,
            sanctions: 10
        },

        schemes: {
            ecdsa: 1,
            rsa: 2
        },

        providers: {
            kyc: {
                name: "Local KYC Provider",
                description: "Local KYC verification service for testing",
                website: "https://localhost:3000/kyc"
            },
            aml: {
                name: "Local AML Provider",
                description: "Local AML compliance service for testing",
                website: "https://localhost:3000/aml"
            },
            compliance: {
                name: "Local Compliance Provider",
                description: "Local compliance verification service for testing",
                website: "https://localhost:3000/compliance"
            }
        },

        security: {
            maxGasPrice: "20", // 20 gwei
            minConfirmations: 1,
            recoveryThreshold: 2, // 2-of-3 recovery
            keyRotationCooldown: 1 // 1 second
        },

        performance: {
            maxDeploymentTime: 10000, // 10 seconds
            maxKeyAdditionGas: 200000, // 200K gas
            maxClaimIssuanceGas: 300000, // 300K gas
            maxTransactionCostUSD: 1 // $1 max per transaction
        },

        testData: {
            individual: {
                fullName: "Local Test User",
                dateOfBirth: "1990-05-15",
                nationality: "US",
                documentType: "PASSPORT",
                address: "123 Local St, Local City, LC 12345, USA"
            },
            corporate: {
                companyName: "Local Test Corp",
                jurisdiction: "Delaware, USA",
                businessType: "Technology",
                incorporationDate: "2020-01-15",
                registrationNumber: "LOCAL123456789"
            },
            institutional: {
                institutionName: "Local Test Fund",
                institutionType: "INVESTMENT_FUND",
                aum: "50000000", // $50M
                regulatoryLicense: "LOCAL-IA-123456",
                jurisdiction: "Local Jurisdiction"
            }
        }
    }
};

// Network configurations
export const NETWORK_CONFIGS: { [key: string]: NetworkConfig } = {
    mainnet: {
        name: "mainnet",
        chainId: 1,
        rpcUrl: "https://mainnet.infura.io/v3/YOUR_PROJECT_ID",
        gasPrice: "20",
        gasLimit: 5000000,
        confirmations: 3,
        blockTime: 12
    },
    sepolia: {
        name: "sepolia",
        chainId: 11155111,
        rpcUrl: "https://sepolia.infura.io/v3/YOUR_PROJECT_ID",
        gasPrice: "10",
        gasLimit: 5000000,
        confirmations: 1,
        blockTime: 12
    },
    hardhat: {
        name: "hardhat",
        chainId: 31337,
        rpcUrl: "http://127.0.0.1:8545",
        gasPrice: "20",
        gasLimit: 5000000,
        confirmations: 1,
        blockTime: 1
    }
};

// Utility functions
export class ConfigManager {
    static getConfig(network: string): ProductionConfig {
        const config = PRODUCTION_CONFIGS[network];
        if (!config) {
            throw new Error(`No configuration found for network: ${network}`);
        }
        return config;
    }

    static getNetworkConfig(network: string): NetworkConfig {
        const config = NETWORK_CONFIGS[network];
        if (!config) {
            throw new Error(`No network configuration found for: ${network}`);
        }
        return config;
    }

    static validateConfig(config: ProductionConfig): boolean {
        // Validate required fields
        if (!config.deploymentFee || !config.topics || !config.providers) {
            return false;
        }

        // Validate numeric values
        if (config.recoveryTimelock <= 0 || config.keyRotationTimelock <= 0) {
            return false;
        }

        // Validate topics
        if (Object.values(config.topics).some(topic => topic <= 0)) {
            return false;
        }

        return true;
    }

    static getCurrentNetwork(): string {
        // In a real implementation, this would detect the current network
        return process.env.HARDHAT_NETWORK || "hardhat";
    }

    static getEnvironmentConfig(): ProductionConfig {
        const network = this.getCurrentNetwork();
        return this.getConfig(network);
    }
}

// Export default configuration for current environment
export const DEFAULT_CONFIG = ConfigManager.getEnvironmentConfig();