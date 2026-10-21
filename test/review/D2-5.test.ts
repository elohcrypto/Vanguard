// D2-5: an escrow keeps the factory's fee wallet (ownerWallet) of its
// creation time. When that was the deployer, the platform fee on release
// still goes to the deployer after the ceremony, so the completion warns
// about every escrow whose owner OR ownerWallet is the deployer, the
// second naming the fee:
//  A) owner == ownerWallet == deployer (the usual history): both warnings;
//  B) owner != deployer, ownerWallet == deployer (the factory was owned by
//     someone else when the escrow was made): the fee-wallet warning.
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { handoverFixture } from "../helpers/governanceFixture";
import { deployIdentity, attest } from "../helpers/kyc";
const { signProof } = require("../helpers/escrowFixture");
const {
  acceptAllByVote,
  assertHandoverComplete,
  handoverDeployerPowers,
} = require("../../demo/utils/Handover");

describe("D2-5 escrows whose fee wallet is the deployer", function () {
  this.timeout(600000);
  it("warns about the escrows that pay the deployer; the fee still goes to it", async function () {
    const f = await handoverFixture();
    const { c, args, deployer, stranger } = f;
    const [, , , , alice, bob, carol] = await ethers.getSigners();
    const e = c.escrowWalletFactory;
    const token = c.token;
    const E = (n: string) => ethers.parseEther(n);

    // The deployer is the platform fee wallet (the demo's single-key setup),
    // and a verified holder so it can receive VSC.
    await e.setOwnerWallet(deployer.address);
    const dId = await deployIdentity(f.factory, deployer.address);
    await c.identityRegistry.registerIdentity(deployer.address, dId, 840);
    await attest(f.kycIssuer, deployer, dId);
    await e.registerInvestor(carol.address, carol.address);

    // Escrow 1 (A): factory owned by the deployer.
    await e
      .connect(carol)
      .createEscrowWallet(alice.address, bob.address, E("100"));
    // Escrow 2 (B): the factory was owned by a stranger when it was made.
    await e.transferOwnership(stranger.address);
    await e.connect(stranger).acceptOwnership();
    await e
      .connect(carol)
      .createEscrowWallet(alice.address, bob.address, E("100"));
    await e.connect(stranger).transferOwnership(deployer.address);
    await e.acceptOwnership();

    const MS = await ethers.getContractFactory("MultiSigEscrowWallet");
    const wallets: any[] = [];
    for (const id of [1, 2]) {
      const w = MS.attach(await e.getWalletAddress(id)) as any;
      wallets.push(w);
      console.log(
        `      escrow ${id} ${await w.getAddress()}: owner ${await w.owner()} ${(await w.owner()) === deployer.address ? "(deployer)" : "(not the deployer)"}; ownerWallet ${await w.ownerWallet()} ${(await w.ownerWallet()) === deployer.address ? "(deployer)" : ""}`,
      );
    }
    expect(await wallets[0].owner()).to.equal(deployer.address);
    expect(await wallets[1].owner()).to.equal(stranger.address);
    for (const w of wallets)
      expect(await w.ownerWallet()).to.equal(deployer.address);

    // Fund both, ship proofs.
    await token.mint(alice.address, E("1000"));
    for (const [i, w] of wallets.entries()) {
      await time.increase(2 * 24 * 3600); // VSC transfer cooldown between alice's two sends
      await token.connect(alice).approve(await e.getAddress(), E("105"));
      await e.connect(alice).fundEscrowWallet(i + 1);
      const data = "ship";
      const hash = ethers.keccak256(ethers.toUtf8Bytes(data));
      await w
        .connect(bob)
        .submitShipmentProof(
          data,
          hash,
          await signProof(bob, await w.getAddress(), hash),
        );
    }

    // The ceremony: step 5 moves the FACTORY's fee wallet to ops, not the escrows'.
    const report = await handoverDeployerPowers({ ...args, log: () => {} });
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    console.log(
      `      factory ownerWallet after the ceremony: ${await e.ownerWallet()} (ops ${f.ops.address})`,
    );
    const { ok, warnings } = await assertHandoverComplete(args);
    const mine = warnings.filter((w: string) => /escrow\(s\)/.test(w));
    console.log(
      `      completion ok=${ok}; escrow warnings:\n        ${mine.join("\n        ")}`,
    );
    const w1 = await wallets[0].getAddress();
    const w2 = await wallets[1].getAddress();
    expect(ok).to.equal(true);
    expect(mine.join("\n")).to.include(w1);
    const fee = mine.filter((w: string) => /ownerWallet/.test(w));
    expect(fee).to.have.lengthOf(1);
    expect(fee[0]).to.include(w1);
    expect(fee[0]).to.include(w2);
    expect(fee[0]).to.match(/platform fee/);

    // After the ceremony both escrows release; the platform fee (2 VSC each)
    // lands on the deployer, not ops.
    await time.increase(15 * 24 * 3600);
    const before = await token.balanceOf(deployer.address);
    const opsBefore = await token.balanceOf(f.ops.address);
    for (const w of wallets) {
      await w.connect(bob).signAsPayee();
      await w.connect(carol).signAsInvestor(true);
    }
    const gain = (await token.balanceOf(deployer.address)) - before;
    console.log(
      `      deployer VSC gained from the two releases: ${ethers.formatEther(gain)}; ops gained ${ethers.formatEther((await token.balanceOf(f.ops.address)) - opsBefore)}`,
    );
    expect(gain).to.equal(E("4"));
    expect((await token.balanceOf(f.ops.address)) - opsBefore).to.equal(0n);
  });

  it("impact check: with an unverified deployer as the escrow's fee wallet the release reverts after the ceremony", async function () {
    const f = await handoverFixture();
    const { c, args, deployer } = f;
    const [, , , , alice, bob, carol] = await ethers.getSigners();
    const e = c.escrowWalletFactory;
    const token = c.token;
    const E = (n: string) => ethers.parseEther(n);
    await e.setOwnerWallet(deployer.address); // the deployer is NOT registered in the identity registry
    await e.registerInvestor(carol.address, carol.address);
    await e
      .connect(carol)
      .createEscrowWallet(alice.address, bob.address, E("100"));
    const w = (await ethers.getContractFactory("MultiSigEscrowWallet")).attach(
      await e.getWalletAddress(1),
    ) as any;
    await token.mint(alice.address, E("1000"));
    await token.connect(alice).approve(await e.getAddress(), E("105"));
    await e.connect(alice).fundEscrowWallet(1);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("ship"));
    await w
      .connect(bob)
      .submitShipmentProof(
        "ship",
        hash,
        await signProof(bob, await w.getAddress(), hash),
      );
    const report = await handoverDeployerPowers({ ...args, log: () => {} });
    await acceptAllByVote({
      governance: c.governance,
      contracts: c,
      proposer: f.proposer,
      voters: f.voters,
      registryProposals: report.registryProposals,
      log: () => {},
    });
    const { ok, warnings } = await assertHandoverComplete(args);
    console.log(
      `      completion ok=${ok}; deployer verified: ${await c.identityRegistry.isVerified(deployer.address)}`,
    );
    const fee = warnings.filter((x: string) => /ownerWallet/.test(x));
    expect(fee.join("\n")).to.include(await w.getAddress());
    await time.increase(15 * 24 * 3600);
    await w.connect(bob).signAsPayee();
    let err = "";
    await w
      .connect(carol)
      .signAsInvestor(true)
      .catch((x: any) => (err = x.message));
    console.log(`      signAsInvestor(true): ${err.slice(0, 160)}`);
    expect(ok).to.equal(true);
    expect(err).to.not.equal("");
    expect(Number(await w.state())).to.equal(0); // still Active: nothing was paid
  });
});
