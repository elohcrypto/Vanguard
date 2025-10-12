import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);

/**
 * Production Test Runner
 * Comprehensive test runner for production readiness validation
 */

interface TestResult {
    name: string;
    passed: boolean;
    duration: number;
    gasUsed?: number;
    error?: string;
}

interface TestSuite {
    name: string;
    tests: TestResult[];
    totalDuration: number;
    passedTests: number;
    failedTests: number;
}

interface ProductionTestReport {
    timestamp: string;
    network: string;
    totalTests: number;
    passedTests: number;
    failedTests: number;
    totalDuration: number;
    suites: TestSuite[];
    gasAnalysis: {
        totalGasUsed: number;
        averageGasPerTest: number;
        maxGasUsed: number;
        minGasUsed: number;
    };
    recommendations: string[];
}

class ProductionTestRunner {
    private network: string;
    private verbose: boolean;
    private outputDir: string;

    constructor(network: string = "hardhat", verbose: boolean = true) {
        this.network = network;
        this.verbose = verbose;
        this.outputDir = path.join(process.cwd(), "test-reports", "production");

        // Ensure output directory exists
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    async runAllTests(): Promise<ProductionTestReport> {
        console.log("🚀 Starting Production Test Suite");
        console.log("=".repeat(60));
        console.log(`Network: ${this.network}`);
        console.log(`Timestamp: ${new Date().toISOString()}`);
        console.log("=".repeat(60));

        const startTime = Date.now();
        const report: ProductionTestReport = {
            timestamp: new Date().toISOString(),
            network: this.network,
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            totalDuration: 0,
            suites: [],
            gasAnalysis: {
                totalGasUsed: 0,
                averageGasPerTest: 0,
                maxGasUsed: 0,
                minGasUsed: Number.MAX_SAFE_INTEGER
            },
            recommendations: []
        };

        try {
            // Run different test suites
            const suites = [
                { name: "Unit Tests", command: "npx hardhat test test/unit/**/*.test.ts" },
                { name: "Integration Tests", command: "npx hardhat test test/integration/**/*.test.ts" },
                { name: "Production Simulation", command: "npx hardhat test test/production/ProductionSimulation.test.ts" },
                { name: "Security Tests", command: "npx hardhat test test/security/**/*.test.ts" },
                { name: "Performance Tests", command: "npx hardhat test test/performance/**/*.test.ts" }
            ];

            for (const suite of suites) {
                console.log(`\n🧪 Running ${suite.name}...`);
                console.log("-".repeat(40));

                const suiteResult = await this.runTestSuite(suite.name, suite.command);
                report.suites.push(suiteResult);

                report.totalTests += suiteResult.tests.length;
                report.passedTests += suiteResult.passedTests;
                report.failedTests += suiteResult.failedTests;

                if (this.verbose) {
                    this.printSuiteResults(suiteResult);
                }
            }

            // Run deployment test
            console.log("\n🚀 Testing Production Deployment...");
            console.log("-".repeat(40));

            const deploymentResult = await this.testProductionDeployment();
            report.suites.push(deploymentResult);

            report.totalTests += deploymentResult.tests.length;
            report.passedTests += deploymentResult.passedTests;
            report.failedTests += deploymentResult.failedTests;

            // Calculate final metrics
            report.totalDuration = Date.now() - startTime;
            this.calculateGasAnalysis(report);
            this.generateRecommendations(report);

            // Generate and save report
            await this.generateReport(report);

            console.log("\n" + "=".repeat(60));
            console.log("🏁 Production Test Suite Complete!");
            this.printFinalResults(report);
            console.log("=".repeat(60));

            return report;

        } catch (error) {
            console.error("❌ Production test suite failed:", error);
            throw error;
        }
    }

    private async runTestSuite(suiteName: string, command: string): Promise<TestSuite> {
        const startTime = Date.now();
        const suite: TestSuite = {
            name: suiteName,
            tests: [],
            totalDuration: 0,
            passedTests: 0,
            failedTests: 0
        };

        try {
            const { stdout, stderr } = await execAsync(command, {
                env: { ...process.env, HARDHAT_NETWORK: this.network }
            });

            // Parse test results from output
            const results = this.parseTestOutput(stdout);
            suite.tests = results;
            suite.passedTests = results.filter(t => t.passed).length;
            suite.failedTests = results.filter(t => !t.passed).length;

            if (stderr && this.verbose) {
                console.log("⚠️  Warnings:", stderr);
            }

        } catch (error: any) {
            console.log(`❌ ${suiteName} failed:`, error.message);
            suite.tests.push({
                name: `${suiteName} Execution`,
                passed: false,
                duration: 0,
                error: error.message
            });
            suite.failedTests = 1;
        }

        suite.totalDuration = Date.now() - startTime;
        return suite;
    }

    private async testProductionDeployment(): Promise<TestSuite> {
        const startTime = Date.now();
        const suite: TestSuite = {
            name: "Production Deployment",
            tests: [],
            totalDuration: 0,
            passedTests: 0,
            failedTests: 0
        };

        try {
            // Test deployment script
            const deployCommand = `npx hardhat run scripts/production/DeployProduction.ts --network ${this.network}`;
            const { stdout, stderr } = await execAsync(deployCommand);

            suite.tests.push({
                name: "Contract Deployment",
                passed: !stderr && stdout.includes("Production Deployment Complete"),
                duration: Date.now() - startTime,
                gasUsed: this.extractGasUsage(stdout)
            });

            suite.passedTests = suite.tests.filter(t => t.passed).length;
            suite.failedTests = suite.tests.filter(t => !t.passed).length;

        } catch (error: any) {
            suite.tests.push({
                name: "Contract Deployment",
                passed: false,
                duration: Date.now() - startTime,
                error: error.message
            });
            suite.failedTests = 1;
        }

        suite.totalDuration = Date.now() - startTime;
        return suite;
    }

    private parseTestOutput(output: string): TestResult[] {
        const results: TestResult[] = [];
        const lines = output.split('\n');

        for (const line of lines) {
            // Parse test results (this is a simplified parser)
            if (line.includes('✓') || line.includes('✅')) {
                const testName = line.replace(/[✓✅]/g, '').trim();
                if (testName) {
                    results.push({
                        name: testName,
                        passed: true,
                        duration: 0, // Would need more sophisticated parsing
                        gasUsed: this.extractGasUsage(line)
                    });
                }
            } else if (line.includes('✗') || line.includes('❌')) {
                const testName = line.replace(/[✗❌]/g, '').trim();
                if (testName) {
                    results.push({
                        name: testName,
                        passed: false,
                        duration: 0,
                        error: "Test failed"
                    });
                }
            }
        }

        return results;
    }

    private extractGasUsage(text: string): number | undefined {
        const gasMatch = text.match(/(\d+(?:,\d+)*)\s*gas/i);
        if (gasMatch) {
            return parseInt(gasMatch[1].replace(/,/g, ''));
        }
        return undefined;
    }

    private calculateGasAnalysis(report: ProductionTestReport): void {
        const gasValues: number[] = [];

        for (const suite of report.suites) {
            for (const test of suite.tests) {
                if (test.gasUsed) {
                    gasValues.push(test.gasUsed);
                }
            }
        }

        if (gasValues.length > 0) {
            report.gasAnalysis.totalGasUsed = gasValues.reduce((sum, gas) => sum + gas, 0);
            report.gasAnalysis.averageGasPerTest = Math.round(report.gasAnalysis.totalGasUsed / gasValues.length);
            report.gasAnalysis.maxGasUsed = Math.max(...gasValues);
            report.gasAnalysis.minGasUsed = Math.min(...gasValues);
        }
    }

    private generateRecommendations(report: ProductionTestReport): void {
        const recommendations: string[] = [];

        // Test coverage recommendations
        const passRate = (report.passedTests / report.totalTests) * 100;
        if (passRate < 95) {
            recommendations.push(`Test pass rate is ${passRate.toFixed(1)}%. Aim for >95% before production deployment.`);
        }

        // Gas usage recommendations
        if (report.gasAnalysis.maxGasUsed > 500000) {
            recommendations.push(`Maximum gas usage (${report.gasAnalysis.maxGasUsed.toLocaleString()}) exceeds 500K. Consider optimization.`);
        }

        // Performance recommendations
        if (report.totalDuration > 300000) { // 5 minutes
            recommendations.push(`Total test duration (${(report.totalDuration / 1000).toFixed(1)}s) is high. Consider parallel execution.`);
        }

        // Security recommendations
        const securitySuite = report.suites.find(s => s.name.includes("Security"));
        if (securitySuite && securitySuite.failedTests > 0) {
            recommendations.push("Security tests failed. Address all security issues before production deployment.");
        }

        // General recommendations
        if (report.failedTests === 0) {
            recommendations.push("All tests passed! System appears ready for production deployment.");
        } else {
            recommendations.push(`${report.failedTests} tests failed. Review and fix all failing tests before production.`);
        }

        report.recommendations = recommendations;
    }

    private printSuiteResults(suite: TestSuite): void {
        console.log(`📊 ${suite.name} Results:`);
        console.log(`   Tests: ${suite.tests.length}`);
        console.log(`   Passed: ${suite.passedTests} ✅`);
        console.log(`   Failed: ${suite.failedTests} ${suite.failedTests > 0 ? '❌' : ''}`);
        console.log(`   Duration: ${(suite.totalDuration / 1000).toFixed(1)}s`);

        if (suite.failedTests > 0 && this.verbose) {
            console.log("   Failed tests:");
            suite.tests.filter(t => !t.passed).forEach(test => {
                console.log(`     - ${test.name}: ${test.error || 'Unknown error'}`);
            });
        }
    }

    private printFinalResults(report: ProductionTestReport): void {
        console.log(`📊 Final Results:`);
        console.log(`   Total Tests: ${report.totalTests}`);
        console.log(`   Passed: ${report.passedTests} ✅`);
        console.log(`   Failed: ${report.failedTests} ${report.failedTests > 0 ? '❌' : ''}`);
        console.log(`   Pass Rate: ${((report.passedTests / report.totalTests) * 100).toFixed(1)}%`);
        console.log(`   Total Duration: ${(report.totalDuration / 1000).toFixed(1)}s`);

        if (report.gasAnalysis.totalGasUsed > 0) {
            console.log(`\n⛽ Gas Analysis:`);
            console.log(`   Total Gas Used: ${report.gasAnalysis.totalGasUsed.toLocaleString()}`);
            console.log(`   Average per Test: ${report.gasAnalysis.averageGasPerTest.toLocaleString()}`);
            console.log(`   Max Gas Used: ${report.gasAnalysis.maxGasUsed.toLocaleString()}`);
        }

        if (report.recommendations.length > 0) {
            console.log(`\n💡 Recommendations:`);
            report.recommendations.forEach((rec, index) => {
                console.log(`   ${index + 1}. ${rec}`);
            });
        }
    }

    private async generateReport(report: ProductionTestReport): Promise<void> {
        const reportPath = path.join(this.outputDir, `production-test-report-${Date.now()}.json`);

        try {
            fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            console.log(`\n📄 Report saved to: ${reportPath}`);

            // Also generate HTML report
            await this.generateHTMLReport(report);

        } catch (error) {
            console.error("❌ Failed to save report:", error);
        }
    }

    private async generateHTMLReport(report: ProductionTestReport): Promise<void> {
        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>OnchainID Production Test Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f0f0f0; padding: 20px; border-radius: 5px; }
        .summary { display: flex; gap: 20px; margin: 20px 0; }
        .metric { background: #e8f4f8; padding: 15px; border-radius: 5px; flex: 1; }
        .suite { margin: 20px 0; border: 1px solid #ddd; border-radius: 5px; }
        .suite-header { background: #f8f8f8; padding: 10px; font-weight: bold; }
        .test { padding: 10px; border-bottom: 1px solid #eee; }
        .passed { color: green; }
        .failed { color: red; }
        .recommendations { background: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🏭 OnchainID Production Test Report</h1>
        <p><strong>Network:</strong> ${report.network}</p>
        <p><strong>Timestamp:</strong> ${report.timestamp}</p>
        <p><strong>Duration:</strong> ${(report.totalDuration / 1000).toFixed(1)}s</p>
    </div>

    <div class="summary">
        <div class="metric">
            <h3>Total Tests</h3>
            <p style="font-size: 24px; margin: 0;">${report.totalTests}</p>
        </div>
        <div class="metric">
            <h3>Passed</h3>
            <p style="font-size: 24px; margin: 0; color: green;">${report.passedTests}</p>
        </div>
        <div class="metric">
            <h3>Failed</h3>
            <p style="font-size: 24px; margin: 0; color: red;">${report.failedTests}</p>
        </div>
        <div class="metric">
            <h3>Pass Rate</h3>
            <p style="font-size: 24px; margin: 0;">${((report.passedTests / report.totalTests) * 100).toFixed(1)}%</p>
        </div>
    </div>

    ${report.gasAnalysis.totalGasUsed > 0 ? `
    <div class="metric">
        <h3>⛽ Gas Analysis</h3>
        <p><strong>Total Gas Used:</strong> ${report.gasAnalysis.totalGasUsed.toLocaleString()}</p>
        <p><strong>Average per Test:</strong> ${report.gasAnalysis.averageGasPerTest.toLocaleString()}</p>
        <p><strong>Max Gas Used:</strong> ${report.gasAnalysis.maxGasUsed.toLocaleString()}</p>
    </div>
    ` : ''}

    <h2>Test Suites</h2>
    ${report.suites.map(suite => `
        <div class="suite">
            <div class="suite-header">
                ${suite.name} (${suite.passedTests}/${suite.tests.length} passed)
            </div>
            ${suite.tests.map(test => `
                <div class="test ${test.passed ? 'passed' : 'failed'}">
                    ${test.passed ? '✅' : '❌'} ${test.name}
                    ${test.gasUsed ? ` (${test.gasUsed.toLocaleString()} gas)` : ''}
                    ${test.error ? `<br><small>Error: ${test.error}</small>` : ''}
                </div>
            `).join('')}
        </div>
    `).join('')}

    ${report.recommendations.length > 0 ? `
    <div class="recommendations">
        <h3>💡 Recommendations</h3>
        <ul>
            ${report.recommendations.map(rec => `<li>${rec}</li>`).join('')}
        </ul>
    </div>
    ` : ''}

</body>
</html>`;

        const htmlPath = path.join(this.outputDir, `production-test-report-${Date.now()}.html`);
        fs.writeFileSync(htmlPath, htmlContent);
        console.log(`📄 HTML report saved to: ${htmlPath}`);
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const network = args.find(arg => arg.startsWith('--network='))?.split('=')[1] || 'hardhat';
    const verbose = !args.includes('--quiet');

    console.log("🚀 OnchainID Production Test Runner");
    console.log(`Network: ${network}`);
    console.log(`Verbose: ${verbose}`);

    const runner = new ProductionTestRunner(network, verbose);

    try {
        const report = await runner.runAllTests();

        if (report.failedTests > 0) {
            console.log("\n❌ Some tests failed. System may not be ready for production.");
            process.exit(1);
        } else {
            console.log("\n✅ All tests passed! System appears ready for production.");
            process.exit(0);
        }
    } catch (error) {
        console.error("❌ Test runner failed:", error);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

export { ProductionTestRunner, ProductionTestReport };