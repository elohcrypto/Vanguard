import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OracleManager, WhitelistOracle, BlacklistOracle } from "../../typechain-types";

// A resolved consensus in OracleManager is keyed by queryId only. Both oracle
// contracts read checkConsensus(queryId) and apply the verdict to whatever
// `subject` the caller names, never checking the queryId was raised FOR that
// subject, nor that it asked the question this oracle answers (query type). One active oracle can therefore self-sign an attestation that
// points a benign, already-resolved query at any victim address.
describe("Oracle consensus is bound to the query subject", function () {
    let oracleManager: OracleManager;
    let whitelistOracle: WhitelistOracle;
    let blacklistOracle: BlacklistOracle;
    let owner: SignerWithAddress;
    let oracle1: SignerWithAddress, oracle2: SignerWithAddress, oracle3: SignerWithAddress;
    let benign: SignerWithAddress, victim: SignerWithAddress;

    const BLACKLIST = 2;
    const WHITELIST = 1;

    beforeEach(async function () {
        [owner, oracle1, oracle2, oracle3, benign, victim] = await ethers.getSigners();

        oracleManager = await (await ethers.getContractFactory("OracleManager")).deploy();
        await oracleManager.waitForDeployment();
        whitelistOracle = await (await ethers.getContractFactory("WhitelistOracle")).deploy(
            await oracleManager.getAddress(), "Whitelist Oracle", "d");
        await whitelistOracle.waitForDeployment();
        blacklistOracle = await (await ethers.getContractFactory("BlacklistOracle")).deploy(
            await oracleManager.getAddress(), "Blacklist Oracle", "d");
        await blacklistOracle.waitForDeployment();

        for (const o of [oracle1, oracle2, oracle3]) {
            await oracleManager["registerOracle(address,string,string,uint256)"](o.address, "o", "d", 500);
        }
    });

    // Raise a query for `subject`, drive it to positive consensus with 3 oracles,
    // and return its queryId (recomputed from the mined block timestamp).
    async function resolvedQuery(subject: string, queryType: number, result: boolean): Promise<string> {
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["q"]);
        const tx = await oracleManager.connect(owner).submitQuery(subject, queryType, data);
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);
        const queryId = ethers.solidityPackedKeccak256(
            ["address", "uint8", "bytes", "uint256", "address"],
            [subject, queryType, data, block!.timestamp, owner.address]
        );
        for (const o of [oracle1, oracle2, oracle3]) {
            await oracleManager.connect(o).submitResponse(queryId, result);
        }
        const [has, res] = await oracleManager.checkConsensus(queryId);
        expect(has).to.equal(true);
        expect(res).to.equal(result);
        return queryId;
    }

    async function sign(signer: SignerWithAddress, subject: string, queryId: string, result: boolean) {
        const chainId = (await ethers.provider.getNetwork()).chainId;
        const hash = ethers.solidityPackedKeccak256(
            ["address", "bytes32", "bool", "uint256"], [subject, queryId, result, chainId]);
        return signer.signMessage(ethers.getBytes(hash));
    }

    it("blacklist: rejects an attestation whose queryId was raised for another subject", async function () {
        const q = await resolvedQuery(benign.address, BLACKLIST, true); // benign, legitimately resolved
        const sig = await sign(oracle1, victim.address, q, true);       // attacker points it at victim
        await expect(
            blacklistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x")
        ).to.be.revertedWithCustomError(blacklistOracle, "QuerySubjectMismatch");
        expect(await blacklistOracle.isBlacklisted(victim.address)).to.equal(false);
    });

    it("whitelist: rejects an attestation whose queryId was raised for another subject", async function () {
        const q = await resolvedQuery(benign.address, WHITELIST, true);
        const sig = await sign(oracle1, victim.address, q, true);
        await expect(
            whitelistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x")
        ).to.be.revertedWithCustomError(whitelistOracle, "QuerySubjectMismatch");
        expect(await whitelistOracle.isWhitelisted(victim.address)).to.equal(false);
    });

    // Augment on PR #5: subject binding alone let a resolved query of ANOTHER
    // TYPE for the same subject be replayed as this oracle's verdict.
    it("blacklist: rejects a resolved WHITELIST query for the same subject", async function () {
        const q = await resolvedQuery(victim.address, WHITELIST, true); // KYC pass, not a blacklist finding
        const sig = await sign(oracle1, victim.address, q, true);
        await expect(
            blacklistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x")
        ).to.be.revertedWithCustomError(blacklistOracle, "QuerySubjectMismatch");
        expect(await blacklistOracle.isBlacklisted(victim.address)).to.equal(false);
    });

    it("whitelist: rejects a resolved BLACKLIST/IDENTITY/COMPLIANCE query for the same subject", async function () {
        for (const type of [BLACKLIST, 3, 4]) {
            const q = await resolvedQuery(victim.address, type, true);
            const sig = await sign(oracle1, victim.address, q, true);
            await expect(
                whitelistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x")
            ).to.be.revertedWithCustomError(whitelistOracle, "QuerySubjectMismatch");
        }
        expect(await whitelistOracle.isWhitelisted(victim.address)).to.equal(false);
    });

    it("blacklist: still accepts an attestation for the query's real subject", async function () {
        const q = await resolvedQuery(victim.address, BLACKLIST, true);
        const sig = await sign(oracle1, victim.address, q, true);
        await blacklistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x");
        expect(await blacklistOracle.isBlacklisted(victim.address)).to.equal(true);
    });

    it("whitelist: still accepts an attestation for the query's real subject", async function () {
        const q = await resolvedQuery(victim.address, WHITELIST, true);
        const sig = await sign(oracle1, victim.address, q, true);
        await whitelistOracle.connect(oracle1).provideAttestation(victim.address, q, true, sig, "0x");
        expect(await whitelistOracle.isWhitelisted(victim.address)).to.equal(true);
    });
});
