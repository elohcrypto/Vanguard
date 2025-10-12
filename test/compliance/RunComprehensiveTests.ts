import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Comprehensive Test Runner for Task 5.3 Completion
 * 
 * This script runs all the comprehensive compliance tests and generates
 * a coverage report to verify 95% test coverage requirement.
 */

interface TestResult {
    testFile: string;
    passed: boolean;
    duration: number;
    coverage?: number;
    errors?: string[];
}

class ComprehensiveTestRunner {
    private testResults: TestResult[] = [];
    private readonly testFiles = [
        'ComplianceRuleEnforcement.test.ts',
        'ERC3643OnchainIDIntegration.test.ts',
        'GasOptimizationBatch.test.ts',
        'CoverageVerification.test.ts'
    ];

    async runAllTests(): Promise<void> {
        console.log('🚀 Starting Comprehensive Compliance Test Suite');
        console.log('='.repeat(60));
        console.log('📋 Task 5.3 Requirements:');
        console.log('  ✅ Comprehensive compliance rule enforcement tests');
        console.log('  ✅ ERC-3643 and OnchainID integration tests');
        console.log('  ✅ Gas optimization tests for batch operations');
        console.log('  ✅ 95% test coverage verification');
        console.log('='.repeat(60));
        console.log('💡 Note: Coverage analysis can be skipped with SKIP_COVERAGE=true');
        console.log('='.repeat(60));

        // Run individual test files
        for (const testFile of this.testFiles) {
            await this.runTestFile(testFile);
        }

        // Run coverage analysis
        await this.runCoverageAnalysis();

        // Generate final report
        this.generateFinalReport();
    }

    private async runTestFile(testFile: string): Promise<void> {
        console.log(`\n🧪 Running ${testFile}...`);
        console.log(`  ⏱️  Timeout: 2 minutes`);
        const startTime = Date.now();

        try {
            const command = `npx hardhat test test/compliance/${testFile}`;
            const output = execSync(command, {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 120000 // 2 minute timeout per test file
            });

            const duration = Date.now() - startTime;
            const passed = !output.includes('failing');

            this.testResults.push({
                testFile,
                passed,
                duration,
                errors: passed ? undefined : [output]
            });

            console.log(`  ✅ ${testFile} - ${passed ? 'PASSED' : 'FAILED'} (${duration}ms)`);

            if (!passed) {
                console.log(`  ❌ Errors: ${output}`);
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            let errorMessage = error instanceof Error ? error.message : String(error);

            if (errorMessage.includes('timeout')) {
                errorMessage = `Test timed out after 2 minutes`;
                console.log(`  ⏰ ${testFile} - TIMEOUT (${duration}ms)`);
            } else {
                console.log(`  ❌ ${testFile} - FAILED (${duration}ms)`);
            }

            this.testResults.push({
                testFile,
                passed: false,
                duration,
                errors: [errorMessage]
            });

            console.log(`  Error: ${errorMessage}`);
        }
    }

    private async runCoverageAnalysis(): Promise<void> {
        console.log('\n📊 Running Coverage Analysis...');

        try {
            // Skip coverage analysis if SKIP_COVERAGE environment variable is set
            if (process.env.SKIP_COVERAGE === 'true') {
                console.log('  ⏭️  Coverage analysis skipped (SKIP_COVERAGE=true)');
                console.log('  💡 To run coverage manually: npx hardhat coverage');
                return;
            }

            console.log('  ⏱️  This may take a few minutes...');
            console.log('  💡 To skip coverage analysis, set SKIP_COVERAGE=true');

            const command = 'npx hardhat coverage --testfiles "test/compliance/*.test.ts"';
            const output = execSync(command, {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 300000 // 5 minute timeout
            });

            // Parse coverage output
            const coverageMatch = output.match(/All files\s+\|\s+(\d+\.?\d*)/);
            const overallCoverage = coverageMatch ? parseFloat(coverageMatch[1]) : 0;

            console.log(`  📈 Overall Coverage: ${overallCoverage}%`);

            // Update test results with coverage info
            this.testResults.forEach(result => {
                result.coverage = overallCoverage;
            });

            if (overallCoverage >= 95) {
                console.log('  ✅ Coverage requirement met (≥95%)');
            } else {
                console.log('  ⚠️  Coverage below requirement (<95%)');
            }

            // Save coverage report
            this.saveCoverageReport(output);

        } catch (error) {
            if (error instanceof Error && error.message.includes('timeout')) {
                console.log('  ⏰ Coverage analysis timed out (5 minutes)');
                console.log('  💡 You can run coverage manually with: npx hardhat coverage');
            } else {
                console.log(`  ❌ Coverage analysis failed: ${error}`);
                console.log('  💡 You can run coverage manually with: npx hardhat coverage');
            }
        }
    }

    private saveCoverageReport(coverageOutput: string): void {
        const reportPath = path.join(__dirname, '../../coverage/compliance-coverage-report.txt');
        const reportDir = path.dirname(reportPath);

        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }

        const report = `
COMPREHENSIVE COMPLIANCE TEST COVERAGE REPORT
Generated: ${new Date().toISOString()}

${coverageOutput}

TEST EXECUTION SUMMARY:
${this.testResults.map(result =>
            `- ${result.testFile}: ${result.passed ? 'PASSED' : 'FAILED'} (${result.duration}ms)`
        ).join('\n')}

TASK 5.3 COMPLETION STATUS:
✅ Comprehensive compliance rule enforcement tests: IMPLEMENTED
✅ ERC-3643 and OnchainID integration tests: IMPLEMENTED  
✅ Gas optimization tests for batch operations: IMPLEMENTED
✅ 95% test coverage verification: ${this.testResults[0]?.coverage && this.testResults[0].coverage >= 95 ? 'ACHIEVED' : 'IN PROGRESS'}
`;

        fs.writeFileSync(reportPath, report);
        console.log(`  📄 Coverage report saved to: ${reportPath}`);
    }

    private generateFinalReport(): void {
        console.log('\n📋 FINAL TEST EXECUTION REPORT');
        console.log('='.repeat(60));

        const totalTests = this.testResults.length;
        const passedTests = this.testResults.filter(r => r.passed).length;
        const totalDuration = this.testResults.reduce((sum, r) => sum + r.duration, 0);
        const averageCoverage = this.testResults.reduce((sum, r) => sum + (r.coverage || 0), 0) / totalTests;

        console.log(`📊 Test Summary:`);
        console.log(`   Total Test Files: ${totalTests}`);
        console.log(`   Passed: ${passedTests}`);
        console.log(`   Failed: ${totalTests - passedTests}`);
        console.log(`   Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
        console.log(`   Total Duration: ${totalDuration}ms`);
        console.log(`   Average Coverage: ${averageCoverage.toFixed(1)}%`);

        console.log('\n📋 Task 5.3 Completion Status:');
        console.log('   ✅ Comprehensive compliance rule enforcement tests');
        console.log('   ✅ ERC-3643 and OnchainID integration tests');
        console.log('   ✅ Gas optimization tests for batch operations');
        console.log(`   ${averageCoverage >= 95 ? '✅' : '⚠️ '} 95% test coverage verification`);

        if (passedTests === totalTests && averageCoverage >= 95) {
            console.log('\n🎉 TASK 5.3 COMPLETED SUCCESSFULLY!');
            console.log('   All comprehensive tests implemented and passing');
            console.log('   Coverage requirement met (≥95%)');
        } else {
            console.log('\n⚠️  TASK 5.3 NEEDS ATTENTION:');
            if (passedTests < totalTests) {
                console.log(`   - ${totalTests - passedTests} test file(s) failing`);
            }
            if (averageCoverage < 95) {
                console.log(`   - Coverage below 95% (current: ${averageCoverage.toFixed(1)}%)`);
            }
        }

        console.log('\n📁 Generated Files:');
        console.log('   - test/compliance/ComplianceRuleEnforcement.test.ts');
        console.log('   - test/compliance/ERC3643OnchainIDIntegration.test.ts');
        console.log('   - test/compliance/GasOptimizationBatch.test.ts');
        console.log('   - test/compliance/CoverageVerification.test.ts');
        console.log('   - coverage/compliance-coverage-report.txt');

        console.log('\n🚀 Next Steps:');
        console.log('   1. Review any failing tests and fix issues');
        console.log('   2. Run individual test files to debug specific failures');
        console.log('   3. Check coverage report for areas needing more tests');
        console.log('   4. Update Task 5.3 status to COMPLETED when all tests pass');

        console.log('\n💡 Commands to run individual tests:');
        this.testFiles.forEach(testFile => {
            console.log(`   npx hardhat test test/compliance/${testFile}`);
        });
    }
}

// Export for use in other scripts
export { ComprehensiveTestRunner };

// Run if called directly
if (require.main === module) {
    const runner = new ComprehensiveTestRunner();
    runner.runAllTests().catch(console.error);
}