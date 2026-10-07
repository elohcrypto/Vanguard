/**
 * @fileoverview Escrow options 69, 73, 73a, 73b: investor release and time travel
 * @module EscrowReleaseFlow
 * @description The investor's release signature, the workflow summary and the two
 * dispute-window time jumps.
 * Moved out of demo/modules/EscrowModule.js (plan v2 Task 4.8). Each
 * function takes the module instance `mod` first (its state, promptUser,
 * logger and sibling methods) and runs the option's code unchanged.
 */

const {
  displaySection,
  displaySuccess,
  displayError,
  displayWarning,
} = require("./DisplayHelpers");
const { advancePast, canJumpTime } = require("./ChainTime");
const { runCompleteWorkflow } = require("./EscrowWorkflowFlow");
const { ethers } = require("hardhat");

/** Option 69: Investor: Sign Release */
async function investorSignRelease(mod) {
  displaySection("INVESTOR: SIGN RELEASE/REFUND", "✍️");

  const readyWallets = Array.from(
    mod.state.enhancedEscrowWallets.values(),
  ).filter(
    (w) =>
      (w.state === "ProofSubmitted" || w.state === "Funded") &&
      w.state !== "Released" &&
      w.state !== "Refunded",
  );
  if (readyWallets.length === 0) {
    displayError("No wallets ready for investor signature");
    console.log("💡 All wallets are either not ready or already completed");
    return;
  }

  console.log("\n📋 WALLETS READY FOR INVESTOR SIGNATURE:");
  readyWallets.forEach((wallet, index) => {
    console.log(
      `${index}. Payment ID ${wallet.paymentId} - ${wallet.payerName} → ${wallet.payeeName}`,
    );
  });

  const walletIndex = await mod.promptUser("\nSelect wallet (number): ");
  const selectedWallet = readyWallets[parseInt(walletIndex)];

  if (!selectedWallet) {
    displayError("Invalid selection");
    return;
  }

  try {
    const investor = await mod.getSignerForAddress(selectedWallet.investor);
    const MultiSigEscrowWallet = await ethers.getContractFactory(
      "MultiSigEscrowWallet",
    );
    const walletAddress =
      selectedWallet.walletAddress || selectedWallet.address;
    const wallet = MultiSigEscrowWallet.attach(walletAddress);

    console.log("\n🔍 PRE-RELEASE COMPLIANCE CHECK:");
    const payee = await wallet.payee();
    const ownerWalletAddr = mod.state.signers[1].address;
    const investorWallet = await wallet.investorWallet();
    // The registry may have been bound after options 61/62 ran.
    await mod._ensureFeeExempt(investorWallet, "investor fee wallet");
    await mod._ensureFeeExempt(await wallet.ownerWallet(), "owner fee wallet");

    const complianceRules = mod.state.getContract("complianceRules");
    const identityRegistry = mod.state.getContract("identityRegistry");

    const isWalletTrusted = await complianceRules[
      "isTrustedContract(address,address)"
    ](mod.state.getContract("digitalToken").target, walletAddress);
    const isPayeeVerified = await identityRegistry.isVerified(payee);
    const isOwnerVerified = await identityRegistry.isVerified(ownerWalletAddr);
    const isInvestorWalletVerified =
      await identityRegistry.isVerified(investorWallet);

    console.log(
      `   Escrow Wallet (${walletAddress.substring(0, 10)}...): ${isWalletTrusted ? "✅ TRUSTED" : "❌ NOT TRUSTED"}`,
    );
    console.log(
      `   Payee (${payee.substring(0, 10)}...): ${isPayeeVerified ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
    );
    // A MultiSigWallet fee wallet (Task 4.3) is trusted, not verified.
    const feeWalletTrusted = await complianceRules[
      "isTrustedContract(address,address)"
    ](mod.state.getContract("digitalToken").target, investorWallet);
    console.log(
      `   Investor Fee Wallet (${investorWallet.substring(0, 10)}...): ${feeWalletTrusted ? "✅ TRUSTED (MultiSigWallet, 2-of-2)" : isInvestorWalletVerified ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
    );
    console.log(
      `   Owner Wallet (${ownerWalletAddr.substring(0, 10)}...): ${isOwnerVerified ? "✅ VERIFIED" : "❌ NOT VERIFIED"}`,
    );

    // The investor must state the direction. It used to be inferred from
    // whoever signed first, which let a payer pre-sign and divert the
    // release into a refund to themselves.
    const payerSigned = await wallet.payerSigned();
    const payeeSigned = await wallet.payeeSigned();
    if (!payerSigned && !payeeSigned) {
      displayWarning(
        "Neither payer nor payee has signed yet - nothing for the investor to co-sign.",
      );
      return;
    }
    // Ask, do not infer. Deriving the direction from payeeSigned here
    // would re-create in JavaScript the exact inference the contract
    // fix removed: if only the payer had signed, the CLI would quietly
    // pick "refund". The contract rejects a mismatched choice, but the
    // operator must be the one making it.
    console.log(
      `\n   Signatures so far: payer ${payerSigned ? "✅" : "❌"}  payee ${payeeSigned ? "✅" : "❌"}`,
    );
    console.log("   1: RELEASE to payee (requires payee signature)");
    console.log("   2: REFUND to payer  (requires payer signature)");
    const dir = (await mod.promptUser("Investor decision (1/2): ")).trim();
    if (dir !== "1" && dir !== "2") {
      displayWarning("No decision made - nothing signed.");
      return;
    }
    const releaseToPayee = dir === "1";
    console.log(
      `\n✍️ Investor signing to ${releaseToPayee ? "RELEASE to payee" : "REFUND to payer"}...`,
    );
    // D26 caps every human recipient of the settlement. Check each leg
    // before signing and say which one fails; the signing call stays the
    // source of truth (a revert is still caught below).
    const token = mod.state.getContract("digitalToken");
    const legs = releaseToPayee
      ? [
          ["payee", payee, await wallet.amount()],
          ["investor fee wallet", investorWallet, await wallet.investorFee()],
          [
            "owner fee wallet",
            await wallet.ownerWallet(),
            await wallet.ownerFee(),
          ],
        ]
      : [
          [
            "payer (refund)",
            await wallet.payer(),
            (await wallet.amount()) +
              (await wallet.investorFee()) +
              (await wallet.ownerFee()),
          ],
        ];
    const types = mod.state.getContract("investorTypeRegistry");
    let blocked = false;
    for (const [label, to, amt] of legs) {
      if (await token.canTransfer(walletAddress, to, amt)) continue;
      blocked = true;
      displayError(
        `Leg to ${label} ${to} (${ethers.formatEther(amt)} VSC) would be refused`,
      );
      const bal = await token.balanceOf(to);
      if (types && !(await types.canHoldAmount(to, bal + amt))) {
        const t = Number(await types.getInvestorType(to));
        const max = (await types.getInvestorTypeConfig(t)).maxHoldingAmount;
        console.log(
          `   Reason: holding cap ${ethers.formatEther(max)} VSC; it holds ${ethers.formatEther(bal)} VSC`,
        );
      } else {
        console.log(
          "   Reason: not the holding cap; check its KYC, country and freeze state",
        );
      }
    }
    if (blocked) {
      console.log(
        "   The settlement would revert atomically; the escrow stays Active.",
      );
      console.log(
        "   Exits: the over-cap party moves balance out, the registry raises its type (options 53/54), or exempt it (option 76, type 0, choice 2 after the handover)",
      );
      return;
    }

    const tx = await wallet.connect(investor).signAsInvestor(releaseToPayee);
    const receipt = await tx.wait();

    // Check if funds were released or refunded
    const releasedEvent = receipt.logs.find((log) => {
      try {
        const parsed = wallet.interface.parseLog(log);
        return parsed && parsed.name === "FundsReleased";
      } catch (e) {
        return false;
      }
    });

    const refundedEvent = receipt.logs.find((log) => {
      try {
        const parsed = wallet.interface.parseLog(log);
        return parsed && parsed.name === "FundsRefunded";
      } catch (e) {
        return false;
      }
    });

    if (releasedEvent) {
      selectedWallet.state = "Released";
      displaySuccess("Funds released to payee!");
      console.log("   Payment completed successfully");
      // Escrow review 2.5.1: the factory's ledger records every release.
      const factory = mod.state.getContract("escrowFactory");
      if (factory) {
        const p = await factory.getInvestorProfile(await wallet.investor());
        console.log(
          `   📒 Investor fees earned (factory ledger): ${ethers.formatEther(p.totalFeesEarned)} VSC, paid to ${p.walletAddress}`,
        );
      }
    } else if (refundedEvent) {
      selectedWallet.state = "Refunded";
      displaySuccess("Funds refunded to payer!");
      console.log("   Refund completed successfully");
    } else {
      displaySuccess("Investor signed successfully!");
      console.log("   Waiting for payee/payer signature");
    }
  } catch (error) {
    if (/Dispute window still open/.test(error.message))
      console.log(
        "⛔ Signing refused (expected): Dispute window still open (73b closes it)",
      );
    else displayError(`Signing failed: ${error.message}`);
  }
}

/**
 * Option 73: Demo Complete Enhanced Escrow Workflow. Runs 62 -> 63 -> 64
 * -> 65 -> 73b -> 68 -> 69 -> 71 with the prompts answered from what each
 * option prints and every verdict read from chain (EscrowWorkflowFlow).
 */
async function demoCompleteWorkflow(mod) {
  return runCompleteWorkflow(mod);
}

/** Option 73a: Time Travel (13 Days) */
async function timeTravel13Days(mod) {
  displaySection(
    "TIME TRAVEL - FAST FORWARD 13 DAYS (TEST DISPUTE WINDOW)",
    "⏰",
  );

  try {
    console.log("\n📅 Current blockchain time will be advanced by 13 days");
    console.log("   • Dispute window is 14 days");
    console.log("   • After 13 days: Dispute window STILL OPEN ⚠️");
    console.log("   • Payer can still raise disputes");
    console.log("   • Payee CANNOT sign yet");
    console.log("");
    console.log("⚠️  This only works on local blockchain (Hardhat/Ganache)");
    console.log("");

    const confirm = await mod.promptUser("Proceed with time travel? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Time travel cancelled");
      return;
    }

    // "13 of 14 days" is a dev-node demonstration of the window still
    // being open. It has no meaning on a network that cannot jump, so
    // there it is skipped rather than waited out.
    if (!(await canJumpTime())) {
      displayWarning(
        "This network cannot jump time; the dispute window closes on its own after 14 days. Use 73b to wait for it.",
      );
      return;
    }
    console.log("\n⏰ Advancing time by 13 days...");
    await ethers.provider.send("evm_increaseTime", [13 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    const latestBlock = await ethers.provider.getBlock("latest");
    const currentTime = new Date(latestBlock.timestamp * 1000);

    displaySuccess("Time advanced successfully!");
    console.log(`   Current blockchain time: ${currentTime.toISOString()}`);
    console.log("");
    console.log("📊 DISPUTE WINDOW STATUS:");
    console.log("   ⚠️  STILL OPEN (1 day remaining)");
    console.log("   ✅ Payer CAN raise disputes (Option 66)");
    console.log("   ❌ Payee CANNOT sign yet (Option 68)");
    console.log("");
    console.log(
      "💡 Use Option 73b to advance 1 more day to close dispute window",
    );
  } catch (error) {
    displayError(`Time travel failed: ${error.message}`);
    console.log(
      "💡 Make sure you are running on a local blockchain (Hardhat/Ganache)",
    );
  }
}

/** Option 73b: Time Travel (14 Days) */
async function timeTravel14Days(mod) {
  displaySection(
    "TIME TRAVEL - FAST FORWARD 14 DAYS (TEST AUTO SETTLEMENT)",
    "⏰",
  );

  try {
    console.log(
      "\n📅 Current blockchain time will be advanced by 14 days + 1 hour",
    );
    console.log("   • Dispute window is 14 days");
    console.log("   • After 14 days: Dispute window CLOSED ✅");
    console.log("   • Payer CANNOT raise disputes anymore");
    console.log("   • Payee CAN sign for release");
    console.log("");
    console.log("⚠️  This only works on local blockchain (Hardhat/Ganache)");
    console.log("");

    const confirm = await mod.promptUser("Proceed with time travel? (y/n): ");
    if (confirm.toLowerCase() !== "y") {
      displayError("Time travel cancelled");
      return;
    }

    // Read the deadline from chain (shipment submittedAt + DISPUTE_WINDOW)
    // for the latest wallet the demo knows has a submitted proof.
    const wallets = Array.from(
      mod.state.enhancedEscrowWallets?.values?.() ?? [],
    );
    const withProof = wallets.filter((w) => w.state === "ProofSubmitted");
    let deadline = null;
    if (withProof.length > 0) {
      const esc = await ethers.getContractAt(
        "MultiSigEscrowWallet",
        withProof[withProof.length - 1].walletAddress,
      );
      const proof = await esc.shipmentProof();
      const win = await esc.DISPUTE_WINDOW();
      if (proof.submittedAt > 0n) deadline = proof.submittedAt + win;
    }
    if (deadline === null) {
      displayError(
        "No escrow wallet with a submitted shipment proof; nothing to wait for (Option 67 first)",
      );
      return;
    }
    await advancePast(deadline, "dispute window", { margin: 3600 });

    const latestBlock = await ethers.provider.getBlock("latest");
    const currentTime = new Date(latestBlock.timestamp * 1000);

    displaySuccess("Time advanced successfully!");
    console.log(`   Current blockchain time: ${currentTime.toISOString()}`);
    console.log("");
    console.log("📊 DISPUTE WINDOW STATUS:");
    console.log("   ✅ CLOSED (14 days passed)");
    console.log("   ❌ Payer CANNOT raise disputes (Option 66)");
    console.log("   ✅ Payee CAN sign for release (Option 68)");
    console.log("");
    console.log("💡 Next steps:");
    console.log("   1. Payee signs release (Option 68)");
    console.log("   2. Investor signs release (Option 69)");
    console.log("   3. Payment automatically released to payee! 🎉");
  } catch (error) {
    displayError(`Time travel failed: ${error.message}`);
    console.log(
      "💡 Make sure you are running on a local blockchain (Hardhat/Ganache)",
    );
  }
}

module.exports = {
  investorSignRelease,
  demoCompleteWorkflow,
  timeTravel13Days,
  timeTravel14Days,
};
