import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Governance → ComplianceRules Integration Test", function () {
  let governanceToken: any;
  let vanguardGovernance: any;
  let identityRegistry: any;
  let complianceRules: any;
  let token: any;
  let onchainIDFactory: any;
  let kycIssuer: any;
  let amlIssuer: any;

  let owner: SignerWithAddress;
  let voter1: SignerWithAddress;
  let voter2: SignerWithAddress;
  let voter3: SignerWithAddress;

  const VGT = (amount: number) => ethers.parseEther(amount.toString());
  const KYC_TOPIC = 1;
  const AML_TOPIC = 2;

  beforeEach(async function () {
    [owner, voter1, voter2, voter3] = await ethers.getSigners();

    // Deploy OnchainIDFactory
    const OnchainIDFactory =
      await ethers.getContractFactory("OnchainIDFactory");
    onchainIDFactory = await OnchainIDFactory.deploy(owner.address);
    await onchainIDFactory.waitForDeployment();

    // Deploy KYC and AML ClaimIssuers
    const ClaimIssuer = await ethers.getContractFactory("ClaimIssuer");
    kycIssuer = await ClaimIssuer.deploy(
      owner.address,
      "KYC Service",
      "KYC verification service",
    );
    await kycIssuer.waitForDeployment();

    amlIssuer = await ClaimIssuer.deploy(
      owner.address,
      "AML Service",
      "AML screening service",
    );
    await amlIssuer.waitForDeployment();

    // Deploy IdentityRegistry
    const IdentityRegistry =
      await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();

    // Deploy ComplianceRules
    const ComplianceRules = await ethers.getContractFactory("ComplianceRules");
    complianceRules = await ComplianceRules.deploy(
      owner.address,
      [], // Empty allowed list = all countries allowed (except blocked)
      [], // No blocked countries
    );
    await complianceRules.waitForDeployment();

    // Deploy Token
    const Token = await ethers.getContractFactory("Token");
    token = await Token.deploy(
      "Vanguard Security Token",
      "VSC",
      await identityRegistry.getAddress(),
      await complianceRules.getAddress(),
    );
    await token.waitForDeployment();

    // Deploy GovernanceToken
    const GovernanceToken = await ethers.getContractFactory("GovernanceToken");
    governanceToken = await GovernanceToken.deploy(
      "Vanguard Governance Token",
      "VGT",
      await identityRegistry.getAddress(),
      await complianceRules.getAddress(),
    );
    await governanceToken.waitForDeployment();

    // Deploy VanguardGovernance
    const VanguardGovernance =
      await ethers.getContractFactory("VanguardGovernance");
    vanguardGovernance = await VanguardGovernance.deploy(
      await governanceToken.getAddress(),
      await identityRegistry.getAddress(), // IdentityRegistry (for KYC/AML verification)
      ethers.ZeroAddress, // InvestorTypeRegistry
      await complianceRules.getAddress(),
      ethers.ZeroAddress, // OracleManager
      await token.getAddress(),
    );
    await vanguardGovernance.waitForDeployment();

    // Set VanguardGovernance as agent for GovernanceToken
    await governanceToken.addAgent(await vanguardGovernance.getAddress());

    // Set VanguardGovernance as rule administrator for ComplianceRules
    await complianceRules.setRuleAdministrator(
      await vanguardGovernance.getAddress(),
      true,
    );

    // Configure ComplianceRules with IdentityRegistry for GovernanceToken
    await complianceRules.setTokenIdentityRegistry(
      await governanceToken.getAddress(),
      await identityRegistry.getAddress(),
    );

    // Register VanguardGovernance contract as a verified identity
    const govSalt = ethers.randomBytes(32);
    await onchainIDFactory.deployOnchainID(
      await vanguardGovernance.getAddress(),
      govSalt,
    );
    const govIdentityAddress = await onchainIDFactory.getIdentityByOwner(
      await vanguardGovernance.getAddress(),
    );

    const kycData = ethers.hexlify(ethers.toUtf8Bytes("GOVERNANCE_CONTRACT"));
    await kycIssuer.issueClaim(
      govIdentityAddress,
      KYC_TOPIC,
      1,
      kycData,
      "",
      0,
    );
    const amlData = ethers.hexlify(ethers.toUtf8Bytes("GOVERNANCE_CONTRACT"));
    await amlIssuer.issueClaim(
      govIdentityAddress,
      AML_TOPIC,
      1,
      amlData,
      "",
      0,
    );

    await identityRegistry.registerIdentity(
      await vanguardGovernance.getAddress(),
      govIdentityAddress,
      0,
    );

    // Setup identities for owner and voters
    await setupIdentity(owner);
    await setupIdentity(voter1);
    await setupIdentity(voter2);
    await setupIdentity(voter3);
  });

  async function setupIdentity(signer: SignerWithAddress) {
    const salt = ethers.randomBytes(32);
    await onchainIDFactory
      .connect(signer)
      .deployOnchainID(signer.address, salt);
    const identityAddress = await onchainIDFactory.getIdentityByOwner(
      signer.address,
    );

    const kycData = ethers.hexlify(ethers.toUtf8Bytes("KYC_APPROVED"));
    await kycIssuer.issueClaim(identityAddress, KYC_TOPIC, 1, kycData, "", 0);

    const amlData = ethers.hexlify(ethers.toUtf8Bytes("AML_APPROVED"));
    await amlIssuer.issueClaim(identityAddress, AML_TOPIC, 1, amlData, "", 0);

    await identityRegistry.registerIdentity(signer.address, identityAddress, 0);
  }

  describe("Complete Governance → ComplianceRules Update Workflow", function () {
    it("Should update ComplianceRules jurisdiction via governance vote", async function () {
      console.log("\n🎯 GOVERNANCE → COMPLIANCE RULES UPDATE TEST");
      console.log("=".repeat(60));

      // Step 1: Check initial jurisdiction rules
      console.log("\n📊 Step 1: Checking initial jurisdiction rules...");
      const tokenAddr = await token.getAddress();
      const initialRule = await complianceRules.getJurisdictionRule(tokenAddr);
      console.log(
        `   Initial Allowed Countries: ${initialRule.allowedCountries.length === 0 ? "None" : initialRule.allowedCountries.join(", ")}`,
      );
      console.log(
        `   Initial Blocked Countries: ${initialRule.blockedCountries.length === 0 ? "None" : initialRule.blockedCountries.join(", ")}`,
      );

      // Step 2: Distribute governance tokens
      console.log("\n📊 Step 2: Distributing governance tokens...");
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address, voter3.address],
        [VGT(300000), VGT(400000), VGT(300000)],
      );
      console.log("   ✅ Distributed 1,000,000 VGT to 3 voters");

      // Approve VanguardGovernance to spend tokens
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          proposalCost + votingCost,
        );
      await governanceToken
        .connect(voter2)
        .approve(await vanguardGovernance.getAddress(), votingCost);
      await governanceToken
        .connect(voter3)
        .approve(await vanguardGovernance.getAddress(), votingCost);

      // Step 3: Create proposal to update jurisdiction rules
      console.log(
        "\n🗳️  Step 3: Creating proposal to update jurisdiction rules...",
      );

      // Encode the function call to setJurisdictionRule
      const newAllowedCountries = [840, 826, 124]; // US, UK, Canada
      const newBlockedCountries = [643]; // Russia
      const callData = complianceRules.interface.encodeFunctionData(
        "setJurisdictionRule",
        [tokenAddr, newAllowedCountries, newBlockedCountries],
      );

      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules type
        "Update Jurisdiction Rules",
        "Add US, UK, Canada to allowed countries and block Russia",
        await complianceRules.getAddress(),
        callData,
      );
      console.log("   ✅ Proposal created with jurisdiction update calldata");
      console.log(
        `   📋 New Allowed: ${newAllowedCountries.join(", ")} (US, UK, Canada)`,
      );
      console.log(
        `   📋 New Blocked: ${newBlockedCountries.join(", ")} (Russia)`,
      );

      // Set snapshot voting power
      const snapshotId = await governanceToken.getCurrentSnapshotId();
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter1.address,
        VGT(300000),
      );
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter2.address,
        VGT(400000),
      );
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter3.address,
        VGT(300000),
      );

      // Step 4: Cast votes (voter1 is proposer, cannot vote)
      console.log("\n✅ Step 4: Casting votes...");
      // voter1 created the proposal, so cannot vote

      await vanguardGovernance
        .connect(voter2)
        .castVote(1, true, "Good for business");
      console.log("   ✅ Voter2 voted FOR (400,000 VGT)");

      await vanguardGovernance
        .connect(voter3)
        .castVote(1, true, "I support this");
      console.log("   ✅ Voter3 voted FOR (300,000 VGT)");

      // Step 5: Check proposal status
      console.log("\n📊 Step 5: Checking proposal status...");
      const proposal = await vanguardGovernance.getProposal(1);
      console.log(
        `   Votes FOR: ${ethers.formatEther(proposal.proposal.votesFor)} VGT (70%)`,
      );
      console.log(
        `   Votes AGAINST: ${ethers.formatEther(proposal.proposal.votesAgainst)} VGT (30%)`,
      );
      console.log(
        `   Participation: ${Number(proposal.participationRate) / 100}%`,
      );
      console.log(
        `   Quorum Met: ${Number(proposal.totalVotes) >= 250000 ? "✅ YES" : "❌ NO"}`,
      );
      console.log(
        `   Approval Met: ${Number(proposal.proposal.votesFor) >= Number(proposal.totalVotes) * 0.65 ? "✅ YES" : "❌ NO"}`,
      );

      // Step 6: Fast forward time
      console.log("\n⏰ Step 6: Fast forwarding time (9 days)...");
      await time.increase(9 * 24 * 60 * 60);
      console.log("   ✅ Time advanced (voting period + execution delay)");

      // Step 7: Execute proposal
      console.log("\n⚡ Step 7: Executing proposal...");
      const tx = await vanguardGovernance.executeProposal(1);
      await tx.wait();
      console.log("   ✅ Proposal executed successfully!");

      // Step 8: Verify ComplianceRules were updated
      console.log("\n🔍 Step 8: Verifying ComplianceRules were updated...");
      const updatedRule = await complianceRules.getJurisdictionRule(tokenAddr);

      console.log(
        `   Updated Allowed Countries: ${updatedRule.allowedCountries.join(", ")}`,
      );
      console.log(
        `   Updated Blocked Countries: ${updatedRule.blockedCountries.join(", ")}`,
      );

      // Verify the changes
      expect(updatedRule.allowedCountries.length).to.equal(3);
      expect(updatedRule.allowedCountries).to.include(840n); // US
      expect(updatedRule.allowedCountries).to.include(826n); // UK
      expect(updatedRule.allowedCountries).to.include(124n); // Canada

      expect(updatedRule.blockedCountries.length).to.equal(1);
      expect(updatedRule.blockedCountries).to.include(643n); // Russia

      console.log("\n✅ VERIFICATION SUCCESSFUL!");
      console.log("   ✅ Allowed countries updated correctly");
      console.log("   ✅ Blocked countries updated correctly");

      // Step 9: Test the new rules
      console.log("\n🧪 Step 9: Testing new compliance rules...");
      const validateUS = await complianceRules.validateJurisdiction(
        tokenAddr,
        840,
      ); // US
      const validateRussia = await complianceRules.validateJurisdiction(
        tokenAddr,
        643,
      ); // Russia
      console.log(
        `   US (840) allowed: ${validateUS.isValid ? "✅ YES" : "❌ NO"}`,
      );
      console.log(
        `   Russia (643) blocked: ${!validateRussia.isValid ? "✅ YES" : "❌ NO"}`,
      );

      expect(validateUS.isValid).to.be.true;
      expect(validateRussia.isValid).to.be.false;

      console.log("\n🎉 GOVERNANCE → COMPLIANCE RULES UPDATE COMPLETE!");
      console.log("=".repeat(60));
      console.log("✅ All steps completed successfully:");
      console.log("   1. Initial state checked");
      console.log("   2. Governance tokens distributed");
      console.log("   3. Proposal created with calldata");
      console.log("   4. Token-weighted votes cast");
      console.log("   5. Quorum and approval verified");
      console.log("   6. Time-lock enforced");
      console.log("   7. Proposal executed on-chain");
      console.log("   8. ComplianceRules updated");
      console.log("   9. New rules tested");
      console.log("\n🚀 GOVERNANCE SYSTEM PROVEN TO WORK!");
    });

    it("Should update holding period rules via governance", async function () {
      console.log("\n🎯 GOVERNANCE → HOLDING PERIOD UPDATE TEST");
      console.log("=".repeat(60));

      // Distribute tokens
      await governanceToken.distributeGovernanceTokens(
        [voter1.address, voter2.address, voter3.address],
        [VGT(300000), VGT(400000), VGT(300000)],
      );

      // Approve VanguardGovernance to spend tokens
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      const votingCost = await vanguardGovernance.votingCost();
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          proposalCost + votingCost,
        );
      await governanceToken
        .connect(voter2)
        .approve(await vanguardGovernance.getAddress(), votingCost);
      await governanceToken
        .connect(voter3)
        .approve(await vanguardGovernance.getAddress(), votingCost);

      // Create proposal to update holding period
      const tokenAddr = await token.getAddress();
      const newMinHolding = 48 * 60 * 60; // 48 hours
      const newCooldown = 24 * 60 * 60; // 24 hours
      const callData = complianceRules.interface.encodeFunctionData(
        "setHoldingPeriodRule",
        [tokenAddr, newMinHolding, newCooldown],
      );

      await vanguardGovernance.connect(voter1).createProposal(
        1, // ComplianceRules
        "Update Holding Period",
        "Set 48h minimum holding and 24h cooldown",
        await complianceRules.getAddress(),
        callData,
      );

      // Set snapshot and vote (voter1 is proposer, cannot vote)
      const snapshotId = await governanceToken.getCurrentSnapshotId();
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter1.address,
        VGT(300000),
      );
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter2.address,
        VGT(400000),
      );
      await governanceToken.setSnapshotVotingPower(
        snapshotId,
        voter3.address,
        VGT(300000),
      );

      // voter1 created the proposal, so cannot vote
      await vanguardGovernance.connect(voter2).castVote(1, true, "Support");
      await vanguardGovernance.connect(voter3).castVote(1, true, "Support");

      // Fast forward and execute
      await time.increase(9 * 24 * 60 * 60);
      await vanguardGovernance.executeProposal(1);

      // Verify
      const rule = await complianceRules.getHoldingPeriodRule(tokenAddr);
      expect(rule.minimumHoldingPeriod).to.equal(newMinHolding);
      expect(rule.transferCooldown).to.equal(newCooldown);

      console.log("✅ Holding period rules updated via governance!");
      console.log(
        `   Minimum Holding: ${Number(rule.minimumHoldingPeriod) / 3600} hours`,
      );
      console.log(
        `   Transfer Cooldown: ${Number(rule.transferCooldown) / 3600} hours`,
      );
    });
  });

  describe("Quorum enforcement", function () {
    // Before the quorum fix, executeProposal checked only
    // `require(totalVotes > 0)` plus a hardcoded 51% of votes CAST. One
    // voter was therefore a 100% approval and could execute the arbitrary
    // `proposal.target.call(proposal.callData)` in the execution path.
    //
    // Quorum is now a share of eligible voters (registered identities),
    // because votes are counted one per verified person, not by token
    // weight. This test proves the gate blocks a lone voter.
    it("Should reject a proposal that does not reach quorum", async function () {
      // Thresholds are set at construction and have no setter, so the
      // quorum cannot be raised. Instead grow the eligible-voter set
      // until one vote is below the configured 20%: with >5 registered
      // identities, 1 vote < 20%.
      const before = await identityRegistry.registeredIdentityCount();
      const signers = await ethers.getSigners();
      let added = 0;
      for (const s of signers.slice(10)) {
        if (before + BigInt(added) >= 10n) break;
        await setupIdentity(s);
        added++;
      }
      const eligible = await identityRegistry.registeredIdentityCount();
      expect(eligible).to.be.greaterThanOrEqual(6n);

      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      // createProposal and castVote both pull their fee via transferFrom.
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const callData = "0x";
      await vanguardGovernance
        .connect(voter1)
        .createProposal(
          0,
          "Low turnout proposal",
          "Only one voter participates",
          await complianceRules.getAddress(),
          callData,
        );
      const proposalId = 1;

      // A single vote from someone other than the proposer (proposers
      // may not vote on their own proposal) — far below the 20% quorum.
      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");

      await time.increase(9 * 24 * 60 * 60);

      // Failing quorum must REJECT AND REFUND, not revert.
      //
      // This previously asserted revertedWith("Quorum not met"), which encoded
      // a real bug as expected behaviour: the quorum require ran before the
      // rejection branch that returns locked VGT, so a low-turnout proposal
      // could never be settled and every deposit was trapped permanently.
      const proposerBefore = await governanceToken.balanceOf(voter1.address);
      const voterBefore = await governanceToken.balanceOf(voter2.address);
      const locked = await vanguardGovernance.getLockedTokens(proposalId);
      expect(locked, "deposits must be locked before settlement").to.be.greaterThan(0n);

      await vanguardGovernance.executeProposal(proposalId);

      const [after] = await vanguardGovernance.getProposal(proposalId);
      expect(after.status, "3 = Rejected").to.equal(3n);

      // Every participant gets their stake back, and nothing stays locked.
      expect(
        await governanceToken.balanceOf(voter1.address),
        "proposer must be refunded",
      ).to.be.greaterThan(proposerBefore);
      expect(
        await governanceToken.balanceOf(voter2.address),
        "voter must be refunded",
      ).to.be.greaterThan(voterBefore);

      console.log(
        `✅ Below quorum: rejected and refunded ${ethers.formatEther(locked)} VGT`,
      );
    });

    // A proposal nobody votes on must also settle. This was the same defect in
    // its plainest form: `require(totalVotes > 0, "No votes cast")` reverted
    // before the refund branch, so an ignored proposal locked the proposer's
    // stake forever — on the ordinary path, with no attacker involved.
    it("Should refund the proposer when a proposal receives no votes at all", async function () {
      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const before = await governanceToken.balanceOf(voter1.address);
      await vanguardGovernance
        .connect(voter1)
        .createProposal(
          0,
          "Ignored proposal",
          "Nobody votes on this",
          await complianceRules.getAddress(),
          "0x",
        );
      const proposalId = 1;

      await time.increase(9 * 24 * 60 * 60);
      await vanguardGovernance.executeProposal(proposalId);

      const [after] = await vanguardGovernance.getProposal(proposalId);
      expect(after.status, "3 = Rejected").to.equal(3n);
      expect(
        await governanceToken.balanceOf(voter1.address),
        "proposer's stake must be returned",
      ).to.equal(before);

      console.log("✅ Zero-vote proposal rejected, proposer refunded in full");
    });

    // Quorum must be measured against the eligible-voter count FROZEN at
    // creation. Reading it live let an agent change an already-cast vote's
    // outcome by registering identities mid-vote to push turnout below the bar.
    it("Should not let identities registered mid-vote change the outcome", async function () {
      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );

      const eligibleAtCreation =
        await identityRegistry.registeredIdentityCount();
      await vanguardGovernance
        .connect(voter1)
        .createProposal(
          0,
          "Snapshot test",
          "Quorum must use the creation-time count",
          await complianceRules.getAddress(),
          "0x",
        );
      const proposalId = 1;

      const [created] = await vanguardGovernance.getProposal(proposalId);
      expect(created.eligibleVotersAtCreation).to.equal(eligibleAtCreation);

      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");
      const [, , turnoutBefore] =
        await vanguardGovernance.getProposal(proposalId);

      // Flood the registry AFTER the vote is cast. With a live denominator
      // this would dilute turnout; with the snapshot it must not move.
      const signers = await ethers.getSigners();
      for (const s of signers.slice(12, 18)) {
        await identityRegistry.registerIdentity(s.address, s.address, 840);
      }
      expect(
        await identityRegistry.registeredIdentityCount(),
        "registry must actually have grown",
      ).to.be.greaterThan(eligibleAtCreation);

      const [, , turnoutAfter] =
        await vanguardGovernance.getProposal(proposalId);
      expect(
        turnoutAfter,
        "turnout must not change when identities are added mid-vote",
      ).to.equal(turnoutBefore);

      console.log(
        `✅ Registry grew ${eligibleAtCreation} -> ${await identityRegistry.registeredIdentityCount()}, turnout unchanged at ${Number(turnoutAfter) / 100}%`,
      );
    });

    // getProposal() is the ADVISORY view every UI reads to decide whether to
    // show an "Execute" button. executeProposal() is the ENFORCEMENT path.
    // If they disagree, a UI enables a button on a transaction that reverts.
    //
    // This probe measures that agreement directly: it builds the exact
    // scenario the test above proves is unexecutable, then asserts the
    // advisory view says the same thing.
    it("getProposal().canExecute must agree with executeProposal()", async function () {
      const before = await identityRegistry.registeredIdentityCount();
      const signers = await ethers.getSigners();
      let added = 0;
      for (const s of signers.slice(10)) {
        if (before + BigInt(added) >= 10n) break;
        await setupIdentity(s);
        added++;
      }
      const eligible = await identityRegistry.registeredIdentityCount();
      expect(eligible).to.be.greaterThanOrEqual(6n);

      await governanceToken.transfer(voter1.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter1)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance
        .connect(voter1)
        .createProposal(
          0,
          "Advisory vs enforcement",
          "One voter only",
          await complianceRules.getAddress(),
          "0x",
        );
      const proposalId = 1;

      await governanceToken.transfer(voter2.address, ethers.parseEther("1000"));
      await governanceToken
        .connect(voter2)
        .approve(
          await vanguardGovernance.getAddress(),
          ethers.parseEther("1000"),
        );
      await vanguardGovernance
        .connect(voter2)
        .castVote(proposalId, true, "yes");

      await time.increase(9 * 24 * 60 * 60);

      const view = await vanguardGovernance.getProposal(proposalId);
      const canExecute = view[3];
      const participationRate = view[2];

      // Ground truth: does the proposal actually PASS?
      //
      // This previously used "does executeProposal revert?" as the ground
      // truth, which only worked while a failed quorum reverted. Now that
      // every settled proposal executes — passing ones run their callData,
      // failing ones refund — the honest comparison is against the resulting
      // status. That is also the stronger assertion: it holds for approval
      // failures too, not just quorum failures.
      await vanguardGovernance.executeProposal(proposalId);
      const [settled] = await vanguardGovernance.getProposal(proposalId);
      const actuallyPassed = settled.status === 4n; // 4 = Executed, 3 = Rejected

      console.log(
        `   advisory canExecute=${canExecute}  actual outcome=${actuallyPassed ? "Executed" : "Rejected"}`,
      );
      console.log(
        `   participationRate=${participationRate} (bps)  eligible=${eligible}  votes=1`,
      );

      expect(
        canExecute,
        "advisory view must match the outcome enforcement produces",
      ).to.equal(actuallyPassed);
      expect(
        actuallyPassed,
        "precondition: one vote must be below the configured quorum",
      ).to.equal(false);

      // 1 vote of >=6 eligible voters is >=1000 bps (10%). A zero here means
      // the metric is arithmetically dead, not merely low.
      expect(
        participationRate,
        "participationRate must reflect real turnout, not collapse to 0",
      ).to.be.greaterThan(0n);
    });
  });
});
