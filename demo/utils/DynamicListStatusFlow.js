/**
 * @fileoverview Dynamic list options 84 and 85: deploy, wire, list status
 * @module DynamicListStatusFlow
 * @description Deploys the dynamic list layer, wires the oracles, shows list status and proof validity.
 * Moved out of demo/modules/DynamicListModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

"use strict";

const {
  displaySection,
  displaySuccess,
  displayError,
} = require("./DisplayHelpers");
const { ethers } = require("hardhat");

/** Option 84: Deploy Dynamic List Manager */
async function deployDynamicListSystem(mod) {
  displaySection("DEPLOY DYNAMIC LIST MANAGER", "🏗️");

  const vanguardGovernance = mod.state.getContract("vanguardGovernance");
  if (!vanguardGovernance) {
    displayError("Deploy Governance system first (option 74)");
    return;
  }

  try {
    console.log("\n📋 Deploying DynamicListManager contract...");

    const DynamicListManager =
      await ethers.getContractFactory("DynamicListManager");
    const dynamicListManager = await DynamicListManager.deploy(
      mod.state.signers[0].address,
    );
    await dynamicListManager.waitForDeployment();

    mod.state.setContract("dynamicListManager", dynamicListManager);
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
    await mod._wireOracles(dynamicListManager, address);

    console.log("\n📊 DEPLOYMENT SUMMARY:");
    console.log("=".repeat(70));
    console.log(`   Contract: DynamicListManager`);
    console.log(`   Address: ${address}`);
    console.log(`   Owner: ${mod.state.signers[0].address}`);
    console.log(`   Governance: ${await vanguardGovernance.getAddress()}`);
    // The whitelist Merkle root lives in PrivacyManager (plan 3.3).
    const privacyManager = mod.state.getContract("privacyManager");
    console.log(
      privacyManager
        ? `   Whitelist root (PrivacyManager): ${await privacyManager.whitelistRoot()} (version ${await privacyManager.whitelistVersion()})`
        : "   Whitelist root: kept by PrivacyManager (option 41), not here",
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
async function _wireOracles(mod, manager, address) {
  const wl = mod.state.getContract("whitelistOracle");
  const bl = mod.state.getContract("blacklistOracle");
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
    const signer = mod.state.signers.find(
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
async function _askNumber(mod, question, def, min, max) {
  const raw = (await mod.promptUser(`${question} [${def}]: `)).trim();
  const n = raw === "" ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`${question}: expected ${min}-${max}, got "${raw}"`);
  return n;
}

/** D20: a list write names its duration: whole days, or "never". */
async function _askDuration(mod, label, def) {
  const raw =
    (
      await mod.promptUser(
        `${label} duration: days (e.g. 365) or "never" [${def}]: `,
      )
    )
      .trim()
      .toLowerCase() || String(def);
  if (raw === "never") return ethers.MaxUint256;
  const days = Number(raw);
  if (!/^\d+$/.test(raw) || days < 1 || days > 36500)
    throw new Error(
      `${label} duration: expected whole days 1-36500 or "never", got "${raw}"`,
    );
  return BigInt(days) * 86400n;
}

/** Expiry of each oracle list add in a receipt, as a date or "never". */
function listExpiries(mod, state, receipt) {
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
async function manageWhitelistBlacklistStatus(mod) {
  displaySection("MANAGE WHITELIST/BLACKLIST STATUS", "📋");

  const dynamicListManager = mod.state.getContract("dynamicListManager");
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

    const choice = await mod.promptUser("Select action (0-3): ");

    switch (choice) {
      case "1":
        await mod._viewUserStatus();
        break;
      case "2":
        await mod._viewAllStatuses();
        break;
      case "3":
        await mod._checkProofValidity();
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
async function _viewUserStatus(mod) {
  console.log("\n👤 VIEW USER STATUS");
  console.log("=".repeat(70));

  const dynamicListManager = mod.state.getContract("dynamicListManager");

  try {
    // Show available users
    console.log("\n📋 Available Users:");
    console.log(`0. Owner: ${mod.state.signers[0].address}`);
    console.log(`1. User 1: ${mod.state.signers[1].address}`);
    console.log(`2. User 2: ${mod.state.signers[2].address}`);
    console.log("");

    const userChoice = await mod.promptUser("Select user (0-2): ");
    const userIndex = parseInt(userChoice);
    const userAddress = mod.state.signers[userIndex].address;
    const identity = BigInt(userAddress) % BigInt(1000000000);

    // Get status
    // Status is the oracles' (the manager keeps no copy, plan 3.3).
    const status = await dynamicListManager.getUserStatus(userAddress);

    const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

    console.log("\n📊 USER STATUS:");
    console.log("=".repeat(70));
    console.log(`   Address: ${userAddress}`);
    console.log(`   Identity: ${identity}`);
    console.log(`   Status (from the oracles): ${statusNames[status]}`);
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
async function _viewAllStatuses(mod) {
  console.log("\n📊 ALL USER STATUSES");
  console.log("=".repeat(70));

  const dynamicListManager = mod.state.getContract("dynamicListManager");

  try {
    const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];

    console.log("\n👥 User Statuses:");
    console.log("");

    for (let i = 0; i < Math.min(5, mod.state.signers.length); i++) {
      const userAddress = mod.state.signers[i].address;
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
async function _checkProofValidity(mod) {
  console.log("\n🔍 CHECK PROOF VALIDITY");
  console.log("=".repeat(70));

  const dynamicListManager = mod.state.getContract("dynamicListManager");

  try {
    console.log("\n📋 Whose proof (status is read from the oracles):");
    for (let i = 0; i < 3; i++) {
      console.log(`${i}. ${mod.state.signers[i].address}`);
    }
    const userIndex = parseInt(await mod.promptUser("Select user (0-2): "));
    const userAddress = (mod.state.signers[userIndex] || mod.state.signers[0])
      .address;

    const proofTimestamp = Math.floor(Date.now() / 1000);

    console.log("\n🎯 Proof Type:");
    console.log("1. Whitelist Membership Proof");
    console.log("2. Blacklist Non-Membership Proof");
    const proofTypeChoice = await mod.promptUser("Select type (1-2): ");
    const isWhitelistProof = proofTypeChoice === "1";

    // Check validity
    const isValid = await dynamicListManager.isProofValid(
      userAddress,
      proofTimestamp,
      isWhitelistProof,
    );

    console.log("\n📊 PROOF VALIDITY CHECK:");
    console.log("=".repeat(70));
    console.log(`   Wallet: ${userAddress}`);
    console.log(
      `   Proof Type: ${isWhitelistProof ? "Whitelist" : "Blacklist Non-Membership"}`,
    );
    console.log(
      `   Timestamp: ${new Date(proofTimestamp * 1000).toLocaleString()}`,
    );
    console.log(`   Valid: ${isValid ? "✅ YES" : "❌ NO"}`);

    if (!isValid) {
      const status = await dynamicListManager.getUserStatus(userAddress);
      const statusNames = ["NONE", "WHITELISTED", "BLACKLISTED"];
      console.log(`\n   ℹ️  Current Status: ${statusNames[status]}`);
      console.log(`   ℹ️  Proof invalidated due to status change or expiry`);
    }
  } catch (error) {
    displayError(`Error: ${error.message}`);
  }
}

module.exports = {
  deployDynamicListSystem,
  _wireOracles,
  _askNumber,
  _askDuration,
  listExpiries,
  manageWhitelistBlacklistStatus,
  _viewUserStatus,
  _viewAllStatuses,
  _checkProofValidity,
};
