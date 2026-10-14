import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  DATA,
  DISPUTE_WINDOW,
  deployEscrow,
  fund,
  newEscrow,
  shipProof,
} from "../helpers/escrow";

// Plan v2 Task 5.3: every MultiSigEscrowWallet guard a party can reach,
// each asserted by its reason (the wallet's branch floor is 80). The
// escrows come from the real factory, funded by the payer.
describe("MultiSigEscrowWallet guards (Task 5.3)", function () {
  async function funded() {
    const f = await loadFixture(deployEscrow);
    const { id, wallet } = await newEscrow(f);
    await fund(f, id, wallet);
    return { f, wallet };
  }

  it("submitShipmentProof refuses empty data, a zero hash and an empty signature", async function () {
    const { f, wallet } = await funded();
    const w = wallet.connect(f.payee);
    const h = ethers.id(DATA);
    await expect(w.submitShipmentProof("", h, "0x01")).to.be.revertedWith(
      "Empty data",
    );
    await expect(
      w.submitShipmentProof(DATA, ethers.ZeroHash, "0x01"),
    ).to.be.revertedWith("Invalid hash");
    await expect(w.submitShipmentProof(DATA, h, "0x")).to.be.revertedWith(
      "Invalid signature",
    );
  });

  it("a refunded escrow takes no proof, dispute, signature or second refund", async function () {
    const { f, wallet } = await funded();
    await wallet.connect(f.investor).manualRefund();
    expect(await wallet.state()).to.equal(2); // Refunded
    const NOT_ACTIVE = "Wallet not active";
    await expect(
      wallet
        .connect(f.payee)
        .submitShipmentProof(DATA, ethers.id(DATA), "0x01"),
    ).to.be.revertedWith(NOT_ACTIVE);
    await expect(wallet.connect(f.payer).raiseDispute()).to.be.revertedWith(
      NOT_ACTIVE,
    );
    await expect(wallet.connect(f.payer).signAsPayer()).to.be.revertedWith(
      NOT_ACTIVE,
    );
    await expect(wallet.connect(f.payee).signAsPayee()).to.be.revertedWith(
      NOT_ACTIVE,
    );
    await expect(
      wallet.connect(f.investor).signAsInvestor(false),
    ).to.be.revertedWith(NOT_ACTIVE);
    await expect(wallet.connect(f.investor).manualRefund()).to.be.revertedWith(
      "Cannot refund in current state",
    );
  });

  it("raiseDispute needs a shipment proof first", async function () {
    const { f, wallet } = await funded();
    await expect(wallet.connect(f.payer).raiseDispute()).to.be.revertedWith(
      "No proof submitted yet",
    );
  });

  it("resolveDispute needs an open dispute", async function () {
    const { f, wallet } = await funded();
    await expect(
      wallet.connect(f.investor).resolveDispute(true),
    ).to.be.revertedWith("No active dispute");
  });

  it("signAsPayer: refused before a payer is set; a payer signs once", async function () {
    const f = await loadFixture(deployEscrow);
    const market = (await newEscrow(f, ethers.ZeroAddress)).wallet;
    await expect(market.connect(f.payer).signAsPayer()).to.be.revertedWith(
      "Payer not set yet",
    );
    const { wallet } = await newEscrow(f);
    await wallet.connect(f.payer).signAsPayer();
    await expect(wallet.connect(f.payer).signAsPayer()).to.be.revertedWith(
      "Already signed",
    );
  });

  it("signAsPayee needs a proof and signs once", async function () {
    const { f, wallet } = await funded();
    await expect(wallet.connect(f.payee).signAsPayee()).to.be.revertedWith(
      "No proof submitted",
    );
    await shipProof(f, wallet);
    await time.increase(DISPUTE_WINDOW + 1);
    await wallet.connect(f.payee).signAsPayee();
    await expect(wallet.connect(f.payee).signAsPayee()).to.be.revertedWith(
      "Already signed",
    );
  });
});
