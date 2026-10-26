// Review D-2, round 8 (the round-7 attacker G's GG2, inverted; mutant
// N11): the runbook's recovery from a stuck stray (a cancel to self at
// its nonce, then resume) found the cancel by a block scan from the
// record's fromBlock, refused past 5000 blocks: about 16.7 h on Sepolia.
// The operator who sent the fill has its hash: DEPLOY_FILL_HASH=<hash>
// is verified by hash (mined, from the stray's sender at its nonce, no
// record entry, no other stray) and recorded as the replacement; past the
// bound the refusal names it. The stray row carries the head block it was
// recorded at, and the scan starts there.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { saveRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
import { strays } from "../helpers/deployRecordStrays";

describe("D-2 round 8: the operator's fill is passed by hash; the scan starts at the stray", function () {
  this.timeout(300000);
  const s = strays();
  afterEach(() => delete process.env.DEPLOY_FILL_HASH);
  const mine = (n: number) =>
    network.provider.request({
      method: "hardhat_mine",
      params: [ethers.toQuantity(n)],
    });
  const id = (stray: string, at: number) =>
    `stray ${stray} (nonce ${at}, the re-send of entry #0)`;
  const fillLine = (at: number, stray: string, by: string) =>
    `   ⚠️  nonce ${at}: stray ${stray} replaced by ${by}, outside the record, never adopted; it cost `;

  /** The pending stray dropped, the cancel at its nonce mined, `n` blocks on. */
  async function cancelled(n: number) {
    const [d] = await ethers.getSigners();
    const { start, stray, hide } = await s.pendingStray();
    await s.drop(stray);
    const fill = await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    await mine(n);
    return { d, start, stray, hide, fill: fill.hash };
  }

  it("GG2: more than 5000 blocks on, the resume is refused naming DEPLOY_FILL_HASH; with the cancel's hash it completes, the fill printed and counted once", async function () {
    const { start, stray, fill } = await cancelled(5001);
    const before = JSON.stringify(s.load());
    const err = await s.resume();
    expect(err).to.contain(`${id(stray, start + 1)}: `);
    expect(err).to.contain("more than 5000 blocks");
    expect(err).to.contain("DEPLOY_FILL_HASH=");
    expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
    process.env.DEPLOY_FILL_HASH = fill;
    const lines: string[] = [];
    expect(await s.resume(lines), "the runbook recovery").to.equal("accepted");
    expect(s.load().strays![0].replacedBy).to.equal(fill);
    expect(
      lines.filter((l) => l.startsWith(fillLine(start + 1, stray, fill))),
    ).to.have.length(1);
    expect(s.load().txs.map((t) => t.status)).to.deep.equal(["confirmed"]);
    expect(await h.nonce()).to.equal(start + 2);
    delete process.env.DEPLOY_FILL_HASH;
    expect(await s.resume(), "a re-run without it").to.equal("accepted");
  });

  it("the stray row carries its block: a deploy older than 5000 blocks with a recent stray is found by the scan, no hash needed", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    await mine(5001); // the deploy began long ago; the stray comes now
    await s.automine(false);
    const restore = s.liar(start, s.load().txs[0].hash!);
    try {
      expect(await h.accepted(s.box.file)).to.contain("outside the record");
    } finally {
      restore();
    }
    const row: any = s.load().strays![0]; // its block: round 8 (B)
    expect(row.block, "stamped").to.be.a("number");
    expect(row.block).to.be.greaterThan(s.load().fromBlock + 5000);
    await s.drop(row.hash);
    const fill = await d.sendTransaction({ to: d.address, nonce: start + 1 });
    await s.automine(true);
    await network.provider.request({ method: "evm_mine" });
    expect(await s.resume()).to.equal("accepted");
    expect(s.load().strays![0].replacedBy).to.equal(fill.hash);
  });

  it("a wrong DEPLOY_FILL_HASH is refused by name, nothing recorded: another sender's, another nonce's, an entry's", async function () {
    const { d, start, stray, hide } = await cancelled(0);
    const other = ethers.Wallet.createRandom().connect(ethers.provider);
    await network.provider.request({
      method: "hardhat_setBalance",
      params: [other.address, ethers.toQuantity(ethers.parseEther("1"))],
    });
    await network.provider.request({
      method: "hardhat_setNonce",
      params: [other.address, ethers.toQuantity(start + 1)],
    });
    const theirs = await (
      await other.sendTransaction({ to: other.address })
    ).wait();
    const later = await (await d.sendTransaction({ to: d.address })).wait();
    const entry = s.load().txs[0];
    const before = JSON.stringify(s.load());
    const refused = async (hash: string) => {
      process.env.DEPLOY_FILL_HASH = hash;
      const err = await s.resume();
      expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
      return err;
    };
    expect(await refused(theirs!.hash)).to.equal(
      `DEPLOY_FILL_HASH ${theirs!.hash} is ${other.address}'s transaction at nonce ${start + 1}, not at a recorded stray's sender and nonce: refusing`,
    );
    expect(await refused(later!.hash)).to.equal(
      `DEPLOY_FILL_HASH ${later!.hash} is ${d.address}'s transaction at nonce ${start + 2}, not at a recorded stray's sender and nonce: refusing`,
    );
    // Entry #0's own transaction (the one the liar hid), mined at start.
    expect(await refused(hide)).to.equal(
      `DEPLOY_FILL_HASH ${hide} is record entry #0's transaction, not a fill: refusing`,
    );
    expect(await refused(stray), "the dropped stray").to.equal(
      `DEPLOY_FILL_HASH ${stray} is not shown by this node: refusing`,
    );
    expect(entry.status).to.equal("sending");
  });

  it("a mined stray's own hash, or a fill still pending, is no fill: refused by name, nothing recorded", async function () {
    const [d] = await ethers.getSigners();
    const start = await h.nonce();
    await h.sendOne(s.box.file);
    const mined = (await (
      await d.sendTransaction({ to: d.address, nonce: start + 1 })
    ).wait())!.hash;
    const rec = s.load();
    const row = { from: d.address, entry: 0, label: rec.txs[0].label };
    rec.strays = [
      { ...row, hash: mined, nonce: start + 1 },
      { ...row, hash: ethers.keccak256("0x77"), nonce: start + 2 },
    ];
    saveRecord(s.box.file, rec);
    const before = JSON.stringify(s.load());
    process.env.DEPLOY_FILL_HASH = mined;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${mined} is stray ${mined} itself, not a fill: refusing`,
    );
    await s.automine(false);
    const pending = await d.sendTransaction({
      to: d.address,
      nonce: start + 2,
      gasLimit: 21000,
    });
    process.env.DEPLOY_FILL_HASH = pending.hash;
    expect(await s.resume()).to.equal(
      `DEPLOY_FILL_HASH ${pending.hash} is not mined on this node: refusing`,
    );
    expect(JSON.stringify(s.load()), "nothing recorded").to.equal(before);
  });
});
