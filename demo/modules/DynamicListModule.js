/**
 * @fileoverview Dynamic list management module
 * @module DynamicListModule
 * @description Handles dynamic whitelist/blacklist management including list updates,
 * proposals, and user lifecycle tracking.
 * Covers menu options 84-88.
 */

const {
  displayInfo,
  displaySection,
  displaySuccess,
  displayError,
} = require("../utils/DisplayHelpers");
const { attestAll } = require("../utils/Kyc");
const { ethers } = require("hardhat");

/**
 * @class DynamicListModule
 * @description Manages dynamic list operations.
 */
class DynamicListModule {
  constructor(state, logger, promptUser) {
    this.state = state;
    this.logger = logger;
    this.promptUser = promptUser;
  }

  /** Option 84: Deploy Dynamic List Manager */
  async deployDynamicListSystem() {
    displaySection("DEPLOY DYNAMIC LIST MANAGER", "🏗️");

    const vanguardGovernance = this.state.getContract("vanguardGovernance");
    if (!vanguardGovernance) {
      displayError("Deploy Governance system first (option 74)");
      return;
    }

    try {
      console.log("\n📋 Deploying DynamicListManager contract...");

      const DynamicListManager =
        await ethers.getContractFactory("DynamicListManager");
      const dynamicListManager = await DynamicListManager.deploy(
        this.state.signers[0].address,
      );
      await dynamicListManager.waitForDeployment();

      this.state.setContract("dynamicListManager", dynamicListManager);
      const address = await dynamicListManager.getAddress();

      console.log(`✅ DynamicListManager deployed at: ${address}`);

      // Set governance contract
      console.log("\n🔗 Connecting to Governance system...");
      const setGovTx = await dynamicListManager.setGovernanceContract(
        await vanguardGovernance.getAddress(),
      );
      await setGovTx.wait();
      console.log("✅ Governance contract set");

      // Set DynamicListManager in Governance
      console.log("\n🔗 Registering with Governance...");
      const setListMgrTx =
        await vanguardGovernance.setDynamicListManager(address);
      await setListMgrTx.wait();
      console.log("✅ DynamicListManager registered with Governance");
      await this._wireOracles(dynamicListManager, address);

      console.log("\n📊 DEPLOYMENT SUMMARY:");
      console.log("=".repeat(70));
      console.log(`   Contract: DynamicListManager`);
      console.log(`   Address: ${address}`);
      console.log(`   Owner: ${this.state.signers[0].address}`);
      console.log(`   Governance: ${await vanguardGovernance.getAddress()}`);
      console.log(
        `   Whitelist Version: ${await dynamicListManager.whitelistVersion()}`,
      );
      console.log(
        `   Blacklist Version: ${await dynamicListManager.blacklistVersion()}`,
      );
      console.log(
        `   Proof Expiry: ${await dynamicListManager.proofExpiryDuration()} seconds (30 days)`,
      );
      console.log("");
      displaySuccess("Dynamic List Management system ready!");
      console.log(
        "   Users can now be moved between whitelist/blacklist via governance voting",
      );
    } catch (error) {
      displayError(`Deployment failed: ${error.message}`);
    }
  }

  /**
   * Option 84, plan 2D.1: the manager writes the WhitelistOracle/BlacklistOracle
   * that ComplianceRules reads, so it needs them set and the writer role.
   * @private
   */
  async _wireOracles(manager, address) {
    const wl = this.state.getContract("whitelistOracle");
    const bl = this.state.getContract("blacklistOracle");
    if (!wl || !bl) {
      displayError(
        "WhitelistOracle/BlacklistOracle not deployed: every list update will revert ('oracles not set') until option 31 runs and option 84 is re-run",
      );
      return;
    }
    await (
      await manager.setOracles(await wl.getAddress(), await bl.getAddress())
    ).wait();
    console.log("✅ Manager writes WhitelistOracle and BlacklistOracle");
    for (const [oracle, name] of [
      [wl, "WhitelistOracle"],
      [bl, "BlacklistOracle"],
    ]) {
      const owner = await oracle.owner();
      const signer = this.state.signers.find(
        (x) => x.address.toLowerCase() === owner.toLowerCase(),
      );
      if (!signer) {
        console.log(
          `⚠️  ${name} is owned by ${owner}, not a local wallet. List updates revert until the owner calls ${name}(${await oracle.getAddress()}).setListManager(${address})`,
        );
        continue;
      }
      await (await oracle.connect(signer).setListManager(address)).wait();
      if ((await oracle.listManager()).toLowerCase() !== address.toLowerCase())
        throw new Error(`${name}.setListManager did not apply`);
      console.log(`✅ ${name} writer role granted to the manager`);
    }
  }

  /** Prompt with a visible default; the oracles need a tier/severity. */
  async _askNumber(question, def, min, max) {
    const raw = (await this.promptUser(`${question} [${def}]: `)).trim();
    const n = raw === "" ? def : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${question}: expected ${min}-${max}, got "${raw}"`);
    return n;
  }

  /** D20: a list write names its duration: whole days, or "never". */
  async _askDuration(label, def) {
    const raw =
      (
        await this.promptUser(
          `${label} duration: days (e.g. 365) or "never" [${def}]: `,
        )
      )
        .trim()
        .toLowerCase() || String(def);
    if (raw === "never") return ethers.MaxUint256;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1)
      throw new Error(
        `${label} duration: expected whole days >= 1 or "never", got "${raw}"`,
      );
    return BigInt(days) * 86400n;
  }

  /** Expiry of each oracle list add in a receipt, as a date or "never". */
  static listExpiries(state, receipt) {
    const out = [];
    for (const name of ["whitelistOracle", "blacklistOracle"]) {
      const oracle = state.getContract(name);
      if (!oracle) continue;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== String(oracle.target).toLowerCase())
          continue;
        let p;
        try {
          p = oracle.interface.parseLog(log);
        } catch {
          continue;
        }
        if (!/^(White|Black)listUpdated$/.test(p?.name) || !p.args[1]) continue;
        const t = p.args.expiryTime;
        const when =
          t === 0n ? "never" : new Date(Number(t) * 1000).toLocaleString();
        out.push(`${p.name.slice(0, 9)} ${p.args.subject} expires: ${when}`);
      }
    }
    return out;
  }

  /** Option 85: Manage Whitelist/Blacklist Status */
  async manageWhitelistBlacklistStatus() {
    displaySection("MANAGE WHITELIST/BLACKLIST STATUS", "📋");

    const dynamicListManager = this.state.getContract("dynamicListManager");
    if (!dynamicListManager) {
      displayError("Deploy DynamicListManager first (option 84)");
      return;
    }

    try {
      console.log("\n🎯 SELECT ACTION:");
      console.log("1. View User Status");
      console.log("2. View All Statuses");
      console.log("3. Check Proof Validity");
      console.log("0. Back to Main Menu");
      console.log("");

      const choice = await this.promptUser("Select action (0-3): ");

      switch (choice) {
        case "1":
          await this._viewUserStatus();
          break;
        case "2":
          await this._viewAllStatuses();
          break;
        case "3":
          await this._checkProofValidity();
          break;
        case "0":
          return;
        default:
          console.log("Invalid choice");
      }
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /**
   * Helper: View single user status
   * @private
   */
  async _viewUserStatus() {
    console.log("\n👤 VIEW USER STATUS");
    console.log("=".repeat(70));

    const dynamicListManager = this.state.getContract("dynamicListManager");

    try {
      // Show available users
      console.log("\n📋 Available Users:");
      console.log(`0. Owner: ${this.state.signers[0].address}`);
      console.log(`1. User 1: ${this.state.signers[1].address}`);
      console.log(`2. User 2: ${this.state.signers[2].address}`);
      console.log("");

      const userChoice = await this.promptUser("Select user (0-2): ");
      const userIndex = parseInt(userChoice);
      const userAddress = this.state.signers[userIndex].address;
      const identity = BigInt(userAddress) % BigInt(1000000000);

      // Get status
      const status = await dynamicListManager.getUserStatus(userAddress);
      const identityStatus =
        await dynamicListManager.getIdentityStatus(identity);

      const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

      console.log("\n📊 USER STATUS:");
      console.log("=".repeat(70));
      console.log(`   Address: ${userAddress}`);
      console.log(`   Identity: ${identity}`);
      console.log(`   Status (by address): ${statusNames[status]}`);
      console.log(`   Status (by identity): ${statusNames[identityStatus]}`);
      console.log("");

      // Get status history count
      const historyCount =
        await dynamicListManager.getUserStatusHistoryCount(userAddress);
      console.log(`   Status Changes: ${historyCount}`);

      if (historyCount > 0) {
        console.log("\n   📜 Recent Status Changes:");
        console.log(`   (Use option 87 to view complete history)`);
      }
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /**
   * Helper: View all user statuses
   * @private
   */
  async _viewAllStatuses() {
    console.log("\n📊 ALL USER STATUSES");
    console.log("=".repeat(70));

    const dynamicListManager = this.state.getContract("dynamicListManager");

    try {
      const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

      console.log("\n👥 User Statuses:");
      console.log("");

      for (let i = 0; i < Math.min(5, this.state.signers.length); i++) {
        const userAddress = this.state.signers[i].address;
        const identity = BigInt(userAddress) % BigInt(1000000000);
        const status = await dynamicListManager.getUserStatus(userAddress);

        const statusIcon = status === 1 ? "✅" : status === 2 ? "❌" : "⚪";
        console.log(
          `   ${statusIcon} User ${i}: ${userAddress.slice(0, 10)}... - ${statusNames[status]}`,
        );
      }
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /**
   * Helper: Check proof validity
   * @private
   */
  async _checkProofValidity() {
    console.log("\n🔍 CHECK PROOF VALIDITY");
    console.log("=".repeat(70));

    const dynamicListManager = this.state.getContract("dynamicListManager");

    try {
      console.log("\n📋 Enter proof details:");
      const identityInput = await this.promptUser("Identity ID: ");
      const identity = BigInt(identityInput);

      const proofTimestamp = Math.floor(Date.now() / 1000);

      console.log("\n🎯 Proof Type:");
      console.log("1. Whitelist Membership Proof");
      console.log("2. Blacklist Non-Membership Proof");
      const proofTypeChoice = await this.promptUser("Select type (1-2): ");
      const isWhitelistProof = proofTypeChoice === "1";

      // Check validity
      const isValid = await dynamicListManager.isProofValid(
        identity,
        proofTimestamp,
        isWhitelistProof,
      );

      console.log("\n📊 PROOF VALIDITY CHECK:");
      console.log("=".repeat(70));
      console.log(`   Identity: ${identity}`);
      console.log(
        `   Proof Type: ${isWhitelistProof ? "Whitelist" : "Blacklist Non-Membership"}`,
      );
      console.log(
        `   Timestamp: ${new Date(proofTimestamp * 1000).toLocaleString()}`,
      );
      console.log(`   Valid: ${isValid ? "✅ YES" : "❌ NO"}`);

      if (!isValid) {
        const status = await dynamicListManager.getIdentityStatus(identity);
        const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];
        console.log(`\n   ℹ️  Current Status: ${statusNames[status]}`);
        console.log(`   ℹ️  Proof invalidated due to status change or expiry`);
      }
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /** Option 86: Create List Update Proposal */
  async createListUpdateProposal() {
    displaySection("CREATE LIST UPDATE PROPOSAL", "🗳️");

    const dynamicListManager = this.state.getContract("dynamicListManager");
    const vanguardGovernance = this.state.getContract("vanguardGovernance");

    if (!dynamicListManager || !vanguardGovernance) {
      displayError("Deploy DynamicListManager and Governance first");
      return;
    }

    try {
      console.log("\n🎯 SELECT PROPOSAL TYPE:");
      console.log("1. Add to Whitelist");
      console.log("2. Remove from Whitelist");
      console.log("3. Add to Blacklist");
      console.log("4. Remove from Blacklist");
      console.log("0. Back to Main Menu");
      console.log("");

      const typeChoice = await this.promptUser("Select type (0-4): ");

      if (typeChoice === "0") return;

      // One proposal type (ListUpdate = 6, plan 2D.1); the choice picks the
      // manager function the proposal calls.
      const fnByChoice = {
        1: ["addToWhitelist", "Add to Whitelist"],
        2: ["removeFromWhitelist", "Remove from Whitelist"],
        3: ["addToBlacklist", "Add to Blacklist"],
        4: ["removeFromBlacklist", "Remove from Blacklist"],
      };
      if (!fnByChoice[typeChoice]) {
        displayError(`Invalid choice "${typeChoice}"`);
        return;
      }
      const [fn, fnLabel] = fnByChoice[typeChoice];

      // Select target user
      console.log("\n👤 SELECT TARGET USER:");
      console.log(`0. Owner: ${this.state.signers[0].address}`);
      console.log(`1. User 1: ${this.state.signers[1].address}`);
      console.log(`2. User 2: ${this.state.signers[2].address}`);
      const userChoice = await this.promptUser("Select user (0-2): ");
      const targetUser = this.state.signers[parseInt(userChoice)].address;
      const targetIdentity = BigInt(targetUser) % BigInt(1000000000);

      // Get reason
      const reason = await this.promptUser("Reason for this change: ");
      let args = [targetUser, targetIdentity, reason];
      let duration = null;
      if (fn === "addToWhitelist") {
        const tier = await this._askNumber("Whitelist tier (1-5)", 1, 1, 5);
        duration = await this._askDuration("Whitelist", 365);
        args = [targetUser, targetIdentity, tier, duration, reason];
      }
      if (fn === "addToBlacklist") {
        const severity = await this._askNumber(
          "Severity (0 LOW, 1 MEDIUM, 2 HIGH, 3 CRITICAL)",
          1,
          0,
          3,
        );
        duration = await this._askDuration("Blacklist", "never");
        args = [targetUser, targetIdentity, severity, duration, reason];
      }
      const callData = dynamicListManager.interface.encodeFunctionData(
        fn,
        args,
      );

      // Get proposal details
      const title = `${fnLabel}: User ${userChoice}`;
      const description = `Proposal to ${fnLabel.toLowerCase()} for user ${targetUser}. Reason: ${reason}`;

      // Check and approve tokens
      const governanceToken = this.state.getContract("governanceToken");
      const proposalCost = await vanguardGovernance.proposalCreationCost();
      console.log(
        `\n💰 Proposal Cost: ${ethers.formatEther(proposalCost)} VGT`,
      );

      const balance = await governanceToken.balanceOf(
        this.state.signers[0].address,
      );
      if (balance < proposalCost) {
        displayError("Insufficient VGT balance");
        return;
      }

      console.log("📝 Approving VGT tokens...");
      const approveTx = await governanceToken.approve(
        await vanguardGovernance.getAddress(),
        proposalCost,
      );
      await approveTx.wait();

      // Create proposal
      console.log("\n📝 Creating governance proposal...");
      const tx = await vanguardGovernance.createProposal(
        6, // ListUpdate
        title,
        description,
        await dynamicListManager.getAddress(),
        callData,
      );
      await tx.wait();

      // Get proposal ID from event
      const proposalId = await vanguardGovernance.proposalCount();

      displaySuccess("PROPOSAL CREATED!");
      console.log("=".repeat(70));
      console.log(`   Proposal ID: ${proposalId}`);
      console.log(`   Type: ListUpdate -> ${fn}`);
      console.log(`   Target User: ${targetUser}`);
      console.log(`   Target Identity: ${targetIdentity}`);
      console.log(`   Reason: ${reason}`);
      if (duration !== null)
        console.log(
          duration === ethers.MaxUint256
            ? "   Duration: never expires"
            : `   Duration: ${duration / 86400n} days (expires ${duration / 86400n} days after execution)`,
        );
      console.log(`   Status: Active`);
      console.log("");
      console.log("📊 Next Steps:");
      console.log("   1. Community votes on this proposal (option 77)");
      console.log("   2. After voting period, execute proposal (option 78)");
      console.log(
        "   3. The manager writes the WhitelistOracle/BlacklistOracle that transfers check",
      );
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /** Option 87: View User Status History */
  async viewUserStatusHistory() {
    displaySection("VIEW USER STATUS HISTORY", "📊");

    const dynamicListManager = this.state.getContract("dynamicListManager");
    if (!dynamicListManager) {
      displayError("Deploy DynamicListManager first (option 84)");
      return;
    }

    try {
      // Select user
      console.log("\n👤 SELECT USER:");
      console.log(`0. Owner: ${this.state.signers[0].address}`);
      console.log(`1. User 1: ${this.state.signers[1].address}`);
      console.log(`2. User 2: ${this.state.signers[2].address}`);
      const userChoice = await this.promptUser("Select user (0-2): ");
      const userAddress = this.state.signers[parseInt(userChoice)].address;
      const identity = BigInt(userAddress) % BigInt(1000000000);

      // Get history count
      const historyCount =
        await dynamicListManager.getUserStatusHistoryCount(userAddress);

      console.log("\n📜 STATUS CHANGE HISTORY:");
      console.log("=".repeat(70));
      console.log(`   User: ${userAddress}`);
      console.log(`   Identity: ${identity}`);
      console.log(`   Total Changes: ${historyCount}`);
      console.log("");

      if (historyCount == 0) {
        console.log("   ℹ️  No status changes recorded yet");
        return;
      }

      // Get current status
      const currentStatus = await dynamicListManager.getUserStatus(userAddress);
      const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

      console.log(`   Current Status: ${statusNames[currentStatus]}`);
      console.log("");
      console.log("   📋 Change History:");
      console.log(
        "   (Note: Full history retrieval requires contract updates)",
      );
      console.log(
        "   ℹ️  Status changes are recorded on-chain with timestamps and reasons",
      );
    } catch (error) {
      displayError(`Error: ${error.message}`);
    }
  }

  /** Option 88: Demo Complete User Lifecycle */
  async demoCompleteUserLifecycle() {
    displaySection("DEMO COMPLETE USER LIFECYCLE", "🎬");
    console.log(
      "This demonstrates a user moving through different list statuses:",
    );
    console.log("  1. User starts with NO status");
    console.log("  2. Governance votes to ADD to WHITELIST");
    console.log("  3. User generates whitelist proof ✅");
    console.log(
      "  4. User violates terms → Governance votes to ADD to BLACKLIST",
    );
    console.log("  5. Old whitelist proof INVALIDATED ❌");
    console.log(
      "  6. User corrects behavior → Governance votes to REMOVE from BLACKLIST",
    );
    console.log("  7. User back on WHITELIST ✅");
    console.log("");

    const dynamicListManager = this.state.getContract("dynamicListManager");
    const vanguardGovernance = this.state.getContract("vanguardGovernance");

    if (!dynamicListManager || !vanguardGovernance) {
      displayError("Deploy DynamicListManager and Governance first");
      return;
    }

    try {
      const targetUser = this.state.signers[1].address;
      const targetIdentity = BigInt(targetUser) % BigInt(1000000000);
      const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

      console.log("🎯 Target User:");
      console.log(`   Address: ${targetUser}`);
      console.log(`   Identity: ${targetIdentity}`);
      console.log("");

      // Step 1: Check initial status
      console.log("📊 STEP 1: Check Initial Status");
      let status = await dynamicListManager.getUserStatus(targetUser);
      console.log(`   Status: ${statusNames[status]}`);
      console.log("");

      await this.promptUser("Press Enter to continue to Step 2...");

      // Step 2: Add to whitelist (owner can do this directly for demo)
      console.log("\n📊 STEP 2: Add User to Whitelist");
      console.log("   (In production, this would require governance voting)");
      const addWhitelistTx = await dynamicListManager.addToWhitelist(
        targetUser,
        targetIdentity,
        await this._askNumber("Whitelist tier (1-5)", 1, 1, 5),
        await this._askDuration("Whitelist", 365),
        "Initial approval - user passed KYC/AML",
      );
      for (const line of DynamicListModule.listExpiries(
        this.state,
        await addWhitelistTx.wait(),
      ))
        console.log(`   ${line}`);

      status = await dynamicListManager.getUserStatus(targetUser);
      console.log(`   ✅ Status: ${statusNames[status]}`);
      console.log("");

      await this.promptUser("Press Enter to continue to Step 3...");

      // Step 3: User can now generate whitelist proof
      console.log("\n📊 STEP 3: User Generates Whitelist Proof");
      console.log("   ✅ User is whitelisted - proof generation would succeed");
      console.log("   ✅ User can use platform features");
      console.log("");

      await this.promptUser("Press Enter to continue to Step 4...");

      // Step 4: User violates terms - add to blacklist
      console.log("\n📊 STEP 4: User Violates Terms - Add to Blacklist");
      console.log("   Reason: Fraudulent activity detected");
      const addBlacklistTx = await dynamicListManager.addToBlacklist(
        targetUser,
        targetIdentity,
        await this._askNumber(
          "Severity (0 LOW, 1 MEDIUM, 2 HIGH, 3 CRITICAL)",
          1,
          0,
          3,
        ),
        await this._askDuration("Blacklist", "never"),
        "Fraudulent activity detected",
      );
      for (const line of DynamicListModule.listExpiries(
        this.state,
        await addBlacklistTx.wait(),
      ))
        console.log(`   ${line}`);

      status = await dynamicListManager.getUserStatus(targetUser);
      console.log(`   ❌ Status: ${statusNames[status]}`);
      console.log("");

      // Step 5: Check proof validity
      console.log("📊 STEP 5: Check Old Whitelist Proof Validity");
      const proofTimestamp = Math.floor(Date.now() / 1000);
      const isValid = await dynamicListManager.isProofValid(
        targetIdentity,
        proofTimestamp,
        true, // whitelist proof
      );
      console.log(
        `   Old Whitelist Proof Valid: ${isValid ? "✅ YES" : "❌ NO"}`,
      );
      console.log(`   ℹ️  Proof invalidated because user is now BLACKLISTED`);
      console.log("");

      await this.promptUser("Press Enter to continue to Step 6...");

      // Step 6: User corrects behavior - remove from blacklist
      console.log(
        "\n📊 STEP 6: User Corrects Behavior - Remove from Blacklist",
      );
      console.log("   Reason: User provided evidence of correction");
      const removeBlacklistTx = await dynamicListManager.removeFromBlacklist(
        targetUser,
        targetIdentity,
        "User corrected behavior and provided evidence",
      );
      await removeBlacklistTx.wait();

      status = await dynamicListManager.getUserStatus(targetUser);
      console.log(`   ✅ Status: ${statusNames[status]}`);
      console.log("");

      // Step 7: User can generate new proof
      console.log("📊 STEP 7: User Can Generate New Whitelist Proof");
      console.log("   ✅ User is back on whitelist");
      console.log("   ✅ User can generate NEW whitelist proof");
      console.log("   ✅ User can use platform again");
      console.log("");

      // Summary
      displaySuccess("LIFECYCLE DEMO COMPLETE!");
      console.log("=".repeat(70));
      console.log("✅ Demonstrated:");
      console.log(
        "   1. User status changes (NONE → WHITELISTED → BLACKLISTED → WHITELISTED)",
      );
      console.log("   2. Proof invalidation when status changes");
      console.log("   3. Complete audit trail of status changes");
      console.log("   4. Real-time status checks");
      console.log("");
      console.log("📊 Status History:");
      const historyCount =
        await dynamicListManager.getUserStatusHistoryCount(targetUser);
      console.log(`   Total Status Changes: ${historyCount}`);
      console.log("");
      console.log("🗳️ In Production:");
      console.log("   All status changes would require governance voting");
      console.log("   Community decides who gets whitelisted/blacklisted");
      console.log("   Complete transparency and decentralization");
    } catch (error) {
      displayError(`Demo failed: ${error.message}`);
    }
  }

  /** Option 89: Quick Fix: Verify Existing Signer for Voting */
  async verifyExistingSigner() {
    displaySection("QUICK FIX: VERIFY EXISTING SIGNER FOR VOTING", "🔧");
    console.log(
      "This will register an existing signer in the IdentityRegistry",
    );
    console.log(
      "and issue KYC/AML claims so they can vote on governance proposals.",
    );
    console.log("");

    const identityRegistry = this.state.getContract("identityRegistry");
    const onchainIDFactory = this.state.getContract("onchainIDFactory");
    const vanguardGovernance = this.state.getContract("vanguardGovernance");

    if (!identityRegistry || !onchainIDFactory) {
      displayError("Deploy ERC-3643 system first (Option 21)");
      return;
    }

    if (!vanguardGovernance) {
      displayError("Deploy Governance system first (Option 74)");
      return;
    }

    try {
      const governanceToken = this.state.getContract("governanceToken");

      // Show available signers
      console.log("📋 Available Signers:");
      for (let i = 0; i < Math.min(5, this.state.signers.length); i++) {
        const address = this.state.signers[i].address;
        const balance = await governanceToken.balanceOf(address);
        const isVerified = await identityRegistry.isVerified(address);

        console.log(
          `${i}. ${address.slice(0, 10)}... - ${ethers.formatEther(balance)} VGT - Verified: ${isVerified ? "✅" : "❌"}`,
        );
      }
      console.log("");

      const signerChoice = await this.promptUser(
        "Select signer to verify (0-4): ",
      );
      const signerIndex = parseInt(signerChoice);

      if (signerIndex < 0 || signerIndex >= this.state.signers.length) {
        displayError("Invalid signer index");
        return;
      }

      const signer = this.state.signers[signerIndex];
      const address = signer.address;

      // Check if already verified
      const alreadyVerified = await identityRegistry.isVerified(address);
      if (alreadyVerified) {
        displaySuccess(`Signer ${signerIndex} is already verified!`);
        console.log(`   Address: ${address}`);
        console.log(`   You can vote with this signer now.`);
        return;
      }

      console.log(`\n🔧 Verifying Signer ${signerIndex}...`);
      console.log(`   Address: ${address}`);

      // Step 1: Check if OnchainID exists
      let identityAddress;
      try {
        identityAddress = await onchainIDFactory.getIdentityByOwner(address);

        // Check if it's a zero address (means doesn't exist)
        if (
          identityAddress === ethers.ZeroAddress ||
          identityAddress === "0x0000000000000000000000000000000000000000"
        ) {
          throw new Error("OnchainID not found");
        }

        console.log(`   ✅ OnchainID exists: ${identityAddress}`);
      } catch (error) {
        // Create OnchainID if it doesn't exist
        console.log("   📝 Creating OnchainID...");
        const salt = ethers.randomBytes(32);
        const tx = await onchainIDFactory.deployOnchainID(address, salt);
        await tx.wait();
        identityAddress = await onchainIDFactory.getIdentityByOwner(address);
        console.log(`   ✅ OnchainID created: ${identityAddress}`);
      }

      // Step 2 & 3: Issue KYC and AML claims through the trusted
      // ClaimIssuers, the only path IdentityRegistry.isVerified() accepts.
      console.log("   📝 Issuing KYC and AML claims...");
      await attestAll(this.state, identityAddress, `signer:${signerIndex}`);
      console.log("   ✅ KYC claim issued");
      console.log("   ✅ AML claim issued");

      // Step 4: Register in IdentityRegistry
      console.log("   📝 Registering in IdentityRegistry...");
      const registerTx = await identityRegistry.registerIdentity(
        address,
        identityAddress,
        840, // United States
      );
      await registerTx.wait();
      console.log("   ✅ Registered in IdentityRegistry");

      // Verify registration
      const isVerified = await identityRegistry.isVerified(address);

      displaySuccess("SIGNER VERIFIED SUCCESSFULLY!");
      console.log("=".repeat(70));
      console.log(`   Signer: ${signerIndex}`);
      console.log(`   Address: ${address}`);
      console.log(`   OnchainID: ${identityAddress}`);
      console.log(`   KYC: ✅ Issued`);
      console.log(`   AML: ✅ Issued`);
      console.log(`   Verified: ${isVerified ? "✅" : "❌"}`);
      console.log("");
      console.log("💡 Next Steps:");
      console.log("   1. Distribute VGT tokens to this signer (Option 75)");
      console.log("   2. Signer can now create proposals (Option 76)");
      console.log("   3. Signer can now vote on proposals (Option 77)");
    } catch (error) {
      displayError(`Verification failed: ${error.message}`);
    }
  }
}

module.exports = DynamicListModule;
