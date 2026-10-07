import { expect } from "chai";
import { addRegistrar } from "../helpers/registrars";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

// Task 2F.4 / D26 (a), findings H4 and L1. A trusted contract (escrow)
// skips the identity pair, but the human side of the transfer still meets
// its investor-type caps: a non-trusted sender its transfer cap, a
// non-trusted recipient its holding cap. Before this, either side being
// trusted skipped both caps, and a settled escrow's public sweepExcess
// relayed 50,000 VSC past both (probe-d P1).
describe("Investor caps on the trusted path (2F.4)", function () {
  const e = ethers.parseEther;
  const NORMAL_TRANSFER_CAP = e("8000");

  async function deploy() {
    const [owner, treasury, alice, bob, payer, payee, investor] =
      await ethers.getSigners();
    const s = await ethers.getSigners();
    const [investorWallet, ownerWallet, stranger] = [s[7], s[8], s[9]];

    const registry = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    const issuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC", "KYC issuer");
    await configureKyc(registry, await issuer.getAddress());
    const OnchainID = await ethers.getContractFactory("OnchainID");
    const humans = [treasury, alice, bob, payer, payee];
    for (const w of [...humans, investorWallet, ownerWallet]) {
      const id = await OnchainID.deploy(w.address);
      await registry.registerIdentity(w.address, id.target, 840);
      await attest(issuer, owner, id.target as string);
    }
    const rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], []);
    const token = await (
      await ethers.getContractFactory("Token")
    ).deploy("VSC", "VSC", registry.target, rules.target);
    await rules.setTokenIdentityRegistry(token.target, registry.target);
    const types = await (
      await ethers.getContractFactory("InvestorTypeRegistry")
    ).deploy();
    await token.setInvestorTypeRegistry(types.target);
    await types.authorizeToken(token.target, true);

    // An exempt treasury seeds balances and trusted contracts.
    await types.setInvestorLimitExempt(treasury.address, true);
    await token.mint(treasury.address, e("1000000"));

    // The predicate must agree with the transfer: same reason, same outcome.
    const agree = async (
      from: SignerWithAddress,
      to: string,
      amount: bigint,
      reason?: string,
    ) => {
      const ok = await token.canTransfer(from.address, to, amount);
      expect(ok, "canTransfer").to.equal(reason === undefined);
      const tx = token.connect(from).transfer(to, amount);
      if (reason) await expect(tx).to.be.revertedWith(reason);
      else await tx;
    };
    return {
      ...{ owner, treasury, alice, bob, payer, payee, investor },
      ...{ investorWallet, ownerWallet, stranger },
      ...{ registry, rules, token, types, agree },
    };
  }

  // A trusted contract the test can speak for: any deployed contract,
  // trusted on the token in ComplianceRules, impersonated to send its own
  // balance. Trust is per token (Task 4.1, G5).
  async function trusted(rules: any, token: any) {
    const c = await (await ethers.getContractFactory("MockTarget")).deploy();
    const addr = await c.getAddress();
    await rules.addTrustedContract(token.target, addr);
    await ethers.provider.send("hardhat_setBalance", [
      addr,
      "0xDE0B6B3A7640000",
    ]);
    return ethers.getImpersonatedSigner(addr);
  }

  describe("Token._checkTransfer with a registry and a trusted contract", function () {
    it("human -> trusted: the sender's transfer cap applies", async function () {
      const { treasury, alice, rules, token, agree } = await deploy();
      const t = await trusted(rules, token);
      await token.connect(treasury).transfer(alice.address, e("20000"));
      await agree(
        alice,
        t.address,
        NORMAL_TRANSFER_CAP + 1n,
        "Transfer amount limit exceeded",
      );
      await agree(alice, t.address, NORMAL_TRANSFER_CAP);
      expect(await token.balanceOf(t.address)).to.equal(NORMAL_TRANSFER_CAP);
    });

    it("trusted -> human: the recipient's holding cap applies", async function () {
      const { treasury, bob, rules, token, agree } = await deploy();
      const t = await trusted(rules, token);
      await token.connect(treasury).transfer(t.address, e("60000"));
      await token.connect(treasury).transfer(bob.address, e("45000"));
      await agree(t, bob.address, e("6000"), "Holding limit exceeded");
      // The trusted sender has no transfer cap of its own: 5,000 lands.
      await agree(t, bob.address, e("5000"));
      expect(await token.balanceOf(bob.address)).to.equal(e("50000"));
    });

    it("trusted -> human: a trusted sender is not held to a transfer cap", async function () {
      const { treasury, bob, rules, token, agree } = await deploy();
      const t = await trusted(rules, token);
      await token.connect(treasury).transfer(t.address, e("60000"));
      await agree(t, bob.address, e("20000")); // above the 8,000 Normal cap
    });

    it("trusted -> trusted: no caps, no identity", async function () {
      const { treasury, rules, token, agree } = await deploy();
      const [t1, t2] = [
        await trusted(rules, token),
        await trusted(rules, token),
      ];
      await token.connect(treasury).transfer(t1.address, e("100000"));
      await agree(t1, t2.address, e("100000"));
    });

    it("an exempt recipient is allowed past the holding cap", async function () {
      const { treasury, bob, rules, token, types, agree } = await deploy();
      const t = await trusted(rules, token);
      await token.connect(treasury).transfer(t.address, e("60000"));
      await agree(t, bob.address, e("60000"), "Holding limit exceeded");
      await types.setInvestorLimitExempt(bob.address, true);
      await agree(t, bob.address, e("60000"));
    });

    it("an exempt sender is allowed past the transfer cap", async function () {
      const { treasury, alice, rules, token, types, agree } = await deploy();
      const t = await trusted(rules, token);
      await token.connect(treasury).transfer(alice.address, e("20000"));
      await types.setInvestorLimitExempt(alice.address, true);
      await agree(alice, t.address, e("20000"));
    });
  });

  describe("escrow legs (MultiSigEscrowWallet on VSC)", function () {
    const AMOUNT = e("1000");
    const TOTAL = e("1050"); // amount + 3% investor fee + 2% owner fee

    async function signProof(
      signer: SignerWithAddress,
      wallet: string,
      dataHash: string,
    ) {
      const { chainId } = await ethers.provider.getNetwork();
      const digest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "address", "uint256", "bytes32"],
          ["VanguardShipmentProof", wallet, chainId, dataHash],
        ),
      );
      return signer.signMessage(ethers.getBytes(digest));
    }

    // Deploys the factory, one funded escrow (payer -> payee, 1,000 VSC),
    // trusted in ComplianceRules, fee wallets exempt (D22) as the deploy
    // configures them; payee shipped and the dispute window has closed.
    async function escrowFixture() {
      const f = await deploy();
      const { owner, treasury, payer, payee, investor } = f;
      const { investorWallet, ownerWallet, rules, token, types } = f;
      const factory = await (
        await ethers.getContractFactory("EscrowWalletFactory")
      ).deploy(
        token.target,
        ownerWallet.address,
        f.registry.target,
        rules.target,
      );
      await addRegistrar(rules, token, factory, "MultiSigEscrowWallet");
      await factory.registerInvestor(investor.address, investorWallet.address);
      await types.setInvestorLimitExempt(investorWallet.address, true);
      await types.setInvestorLimitExempt(ownerWallet.address, true);

      await factory
        .connect(investor)
        .createEscrowWallet(payer.address, payee.address, AMOUNT);
      const walletAddr = await factory.getWalletAddress(1);
      const wallet = await ethers.getContractAt(
        "MultiSigEscrowWallet",
        walletAddr,
      );

      await token.connect(treasury).transfer(payer.address, e("5000"));
      await token.connect(payer).approve(factory.target, TOTAL);
      await factory.connect(payer).fundEscrowWallet(1);

      const data = "shipped";
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(data));
      await wallet
        .connect(payee)
        .submitShipmentProof(
          data,
          dataHash,
          await signProof(payee, walletAddr, dataHash),
        );
      await time.increase(15 * 24 * 60 * 60);
      await wallet.connect(payee).signAsPayee();
      return { ...f, factory, wallet, walletAddr };
    }

    it("P1 relay: deposit capped, stranger cannot sweep, payer's holding cap holds", async function () {
      const f = await escrowFixture();
      const {
        treasury,
        alice,
        payer,
        investor,
        stranger,
        token,
        types,
        agree,
      } = f;
      const { wallet, walletAddr } = f;
      await wallet.connect(investor).signAsInvestor(true);
      expect(await wallet.state()).to.equal(1n); // Released

      // 50,000 into the released escrow by a Normal holder: transfer cap.
      await token.connect(treasury).transfer(alice.address, e("50000"));
      await agree(
        alice,
        walletAddr,
        e("50000"),
        "Transfer amount limit exceeded",
      );

      // A smaller deposit lands; the sweep is for escrow parties only.
      await agree(alice, walletAddr, e("5000"));
      await expect(
        wallet.connect(stranger).sweepExcess(),
      ).to.be.revertedWithCustomError(wallet, "NotEscrowParty");

      // The payer is a party, but the sweep pays the payer, whose holding
      // cap still applies: 46,000 + 5,000 > 50,000.
      const top = e("46000") - (await token.balanceOf(payer.address));
      await token.connect(treasury).transfer(payer.address, top);
      await expect(wallet.connect(payer).sweepExcess()).to.be.revertedWith(
        "Holding limit exceeded",
      );
      await expect(wallet.connect(investor).sweepExcess()).to.be.revertedWith(
        "Holding limit exceeded",
      );

      // Within the cap (payer exempted by the registry owner), it sweeps.
      await types.setInvestorLimitExempt(payer.address, true);
      await expect(wallet.connect(payer).sweepExcess())
        .to.emit(wallet, "ExcessSwept")
        .withArgs(payer.address, e("5000"));
    });

    it("Task 4.10: funding writes the payer's clock, the release writes none", async function () {
      const f = await escrowFixture();
      const { payer, payee, alice, investor, token, types, wallet } = f;
      // fundEscrowWallet moved the payer's tokens by transferFrom.
      const funded = await types.lastTransferAt(payer.address);
      expect(funded).to.be.gt(0n);
      // The fixture's 15-day dispute window outlasted the 60-minute cooldown.
      expect(await types.canTransferNow(payer.address)).to.equal(true);
      await f.agree(payer, alice.address, 1n);
      await f.agree(payer, alice.address, 1n, "Transfer cooldown");
      const sent = await types.lastTransferAt(payer.address);
      await wallet.connect(investor).signAsInvestor(true);
      expect(await wallet.state()).to.equal(1n); // Released
      for (const a of [f.walletAddr, payee.address, f.investorWallet.address])
        expect(await types.lastTransferAt(a)).to.equal(0n);
      expect(await types.lastTransferAt(payer.address)).to.equal(sent);
    });

    it("an over-cap release reverts at release; the refund path stays open", async function () {
      const { treasury, payer, payee, investor, token, wallet, walletAddr } =
        await escrowFixture();
      await token.connect(treasury).transfer(payee.address, e("49500"));
      expect(await token.canTransfer(walletAddr, payee.address, AMOUNT)).to.be
        .false;
      await expect(
        wallet.connect(investor).signAsInvestor(true),
      ).to.be.revertedWith("Holding limit exceeded");
      expect(await wallet.state()).to.equal(0n); // still Active

      const before = await token.balanceOf(payer.address);
      await wallet.connect(payer).signAsPayer();
      await wallet.connect(investor).signAsInvestor(false);
      expect(await wallet.state()).to.equal(2n); // Refunded
      expect((await token.balanceOf(payer.address)) - before).to.equal(TOTAL);
      expect(await token.balanceOf(walletAddr)).to.equal(0n);
    });

    for (const fix of ["raised to Institutional", "exempted"]) {
      it(`the same release succeeds once the payee is ${fix}`, async function () {
        const f = await escrowFixture();
        const { treasury, token, types, wallet } = f;
        await token.connect(treasury).transfer(f.payee.address, e("49500"));
        await expect(
          wallet.connect(f.investor).signAsInvestor(true),
        ).to.be.revertedWith("Holding limit exceeded");

        if (fix === "exempted")
          await types.setInvestorLimitExempt(f.payee.address, true);
        else await types.assignInvestorType(f.payee.address, 3);
        await wallet.connect(f.investor).signAsInvestor(true);
        expect(await wallet.state()).to.equal(1n); // Released
        expect(await token.balanceOf(f.payee.address)).to.equal(e("50500"));
        expect(await token.balanceOf(f.investorWallet.address)).to.equal(
          e("30"),
        );
        expect(await token.balanceOf(f.ownerWallet.address)).to.equal(e("20"));
      });
    }
  });
});
