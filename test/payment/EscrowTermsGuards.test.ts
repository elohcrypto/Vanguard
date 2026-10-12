import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Task 4.15 (C §2 MultiSigEscrowTerms rows; C §3 N67, N68). The escrow's
// terms contract: its constructor refuses a zero or self-dealing party,
// markFunded is the factory's and runs once, setPayer is the investor's,
// the owner's or the factory's and runs once.
describe("Escrow terms guards (Task 4.15)", function () {
  let factory: SignerWithAddress, payer: SignerWithAddress;
  let payee: SignerWithAddress, investor: SignerWithAddress;
  let owner: SignerWithAddress, stranger: SignerWithAddress;
  let W: any, tok: string;
  const AMOUNT = 1000n;

  beforeEach(async function () {
    [factory, payer, payee, investor, owner, stranger] =
      await ethers.getSigners();
    W = (await ethers.getContractFactory("MultiSigEscrowWallet")).connect(
      factory,
    );
    tok = await (
      await (await ethers.getContractFactory("MockToken")).deploy("M", "M", 0)
    ).getAddress();
  });

  const args = (o: Record<string, any> = {}) => {
    const a: any = {
      paymentId: 1,
      payer: payer.address,
      payee: payee.address,
      investor: investor.address,
      token: tok,
      amount: AMOUNT,
      investorFee: 10n,
      ownerFee: 5n,
      owner: owner.address,
      investorWallet: investor.address,
      ownerWallet: owner.address,
      ...o,
    };
    return [
      a.paymentId,
      a.payer,
      a.payee,
      a.investor,
      a.token,
      a.amount,
      a.investorFee,
      a.ownerFee,
      a.owner,
      a.investorWallet,
      a.ownerWallet,
    ];
  };

  it("the constructor refuses zero parties, a codeless token and a zero amount (164-176)", async function () {
    const Z = ethers.ZeroAddress;
    for (const [o, reason] of [
      [{ payee: Z }, "Invalid payee"],
      [{ investor: Z }, "Invalid investor"],
      [{ token: Z }, "Invalid token"],
      [
        { token: stranger.address },
        "MultiSigEscrowWallet: VSC token is not a contract",
      ],
      [{ amount: 0n }, "Invalid amount"],
      [{ owner: Z }, "Invalid owner"],
      [{ investorWallet: Z }, "Invalid investor wallet"],
      [{ ownerWallet: Z }, "Invalid owner wallet"],
    ] as [Record<string, any>, string][])
      await expect(W.deploy(...args(o))).to.be.revertedWith(reason);
    const w = await W.deploy(...args());
    expect(await w.factory()).to.equal(factory.address);
    expect(await w.payerSet()).to.equal(true);
  });

  it("the constructor refuses self-dealing parties", async function () {
    const ref = await W.deploy(...args()); // carries the error ABI
    for (const [o, name] of [
      [{ investor: payee.address }, "InvestorCannotBePayee"],
      [{ investor: payer.address }, "InvestorCannotBePayer"],
      [{ payer: payee.address }, "PayerCannotBePayee"],
    ] as [Record<string, any>, string][])
      await expect(W.deploy(...args(o))).to.be.revertedWithCustomError(
        ref,
        name,
      );
  });

  it("markFunded is the factory's and runs once (N68)", async function () {
    const w = await W.deploy(...args());
    for (const who of [stranger, owner, investor])
      await expect(w.connect(who).markFunded()).to.be.revertedWithCustomError(
        w,
        "OnlyFactory",
      );
    expect(await w.funded()).to.equal(false);
    await w.connect(factory).markFunded();
    expect(await w.funded()).to.equal(true);
    await expect(w.connect(factory).markFunded()).to.be.revertedWithCustomError(
      w,
      "AlreadyFunded",
    );
  });

  it("setPayer: investor, owner or factory, once, a real party (N67)", async function () {
    const w = await W.deploy(...args({ payer: ethers.ZeroAddress }));
    expect(await w.payerSet()).to.equal(false);
    for (const who of [stranger, payee])
      await expect(w.connect(who).setPayer(payer.address)).to.be.revertedWith(
        "Only investor, owner, or factory",
      );
    await expect(
      w.connect(owner).setPayer(ethers.ZeroAddress),
    ).to.be.revertedWith("Invalid payer");
    await expect(
      w.connect(owner).setPayer(investor.address),
    ).to.be.revertedWithCustomError(w, "InvestorCannotBePayer");
    await expect(
      w.connect(owner).setPayer(payee.address),
    ).to.be.revertedWithCustomError(w, "PayerCannotBePayee");
    expect(await w.payer()).to.equal(ethers.ZeroAddress);
    await expect(w.connect(investor).setPayer(payer.address)).to.emit(
      w,
      "PayerSet",
    );
    expect(await w.payer()).to.equal(payer.address);
    for (const who of [investor, owner, factory])
      await expect(
        w.connect(who).setPayer(stranger.address),
      ).to.be.revertedWith("Payer already set");
    const known = await W.deploy(...args());
    await expect(
      known.connect(factory).setPayer(stranger.address),
    ).to.be.revertedWith("Payer already set");
  });

  // Task 4.17 slice A (review C CF-3, mutants E01-E05): each signature,
  // the dispute and the proof belong to one party; a proof lands once.
  describe("party gates (Task 4.17)", function () {
    const proof = async (w: any, signer: SignerWithAddress, data: string) => {
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(data));
      const { chainId } = await ethers.provider.getNetwork();
      const digest = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["string", "address", "uint256", "bytes32"],
          ["VanguardShipmentProof", await w.getAddress(), chainId, dataHash],
        ),
      );
      const sig = await signer.signMessage(ethers.getBytes(digest));
      return w.connect(signer).submitShipmentProof(data, dataHash, sig);
    };

    it("signAsPayer, signAsPayee and signAsInvestor refuse every other party (E01-E03)", async function () {
      const w = await W.deploy(...args());
      for (const who of [stranger, payee, investor])
        await expect(w.connect(who).signAsPayer()).to.be.revertedWith(
          "Only payer can sign",
        );
      for (const who of [stranger, payer, investor])
        await expect(w.connect(who).signAsPayee()).to.be.revertedWith(
          "Only payee can sign",
        );
      for (const who of [stranger, payer, payee])
        await expect(w.connect(who).signAsInvestor(false)).to.be.revertedWith(
          "Only investor can sign",
        );
      expect(await w.payerSigned()).to.equal(false);
      expect(await w.investorSigned()).to.equal(false);
      await w.connect(payer).signAsPayer();
      expect(await w.payerSigned()).to.equal(true);
    });

    it("raiseDispute is the payer's (E04); a second proof is refused (E05)", async function () {
      const w = await W.deploy(...args());
      await proof(w, payee, '{"tracking":"1"}');
      for (const who of [stranger, payee, investor])
        await expect(w.connect(who).raiseDispute()).to.be.revertedWith(
          "Only payer can dispute",
        );
      await expect(proof(w, payee, '{"tracking":"2"}')).to.be.revertedWith(
        "Proof already submitted",
      );
      expect((await w.shipmentProof()).data).to.equal('{"tracking":"1"}');
      await expect(w.connect(payer).raiseDispute()).to.emit(w, "DisputeRaised");
    });

    it("the factory refuses an escrow whose payer is its payee (E06)", async function () {
      const reg = await (
        await ethers.getContractFactory("IdentityRegistry")
      ).deploy();
      const rules = await (
        await ethers.getContractFactory("ComplianceRules")
      ).deploy(owner.address, [840], []);
      const f = await (
        await ethers.getContractFactory("EscrowWalletFactory")
      ).deploy(tok, owner.address, reg.target, rules.target);
      await f.registerInvestor(investor.address, investor.address);
      await expect(
        f
          .connect(investor)
          .createEscrowWallet(payee.address, payee.address, 1n),
      ).to.be.revertedWith("Payer cannot be payee");
      await expect(
        f
          .connect(investor)
          .createEscrowWallet(payer.address, payee.address, 1n),
      ).to.be.revertedWith("Payee must have valid KYC/AML (OnchainID)");
    });
  });
});
