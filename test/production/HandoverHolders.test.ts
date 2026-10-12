import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const {
  preflightHolders,
  holderLines,
  holderStanding,
} = require("../../demo/utils/HandoverHolders");

/**
 * Task 4.16 (D47): with a whitelist oracle bound to VSC, the ceremony's
 * preflight refuses an unlisted holder in OracleOnly and a holder listed
 * below its type's tier in any mode that reads the entry, warns on an
 * unlisted holder in Either, and reads nothing in ZkOnly; the completion
 * prints the same standing. Holders come from the Transfer scan; trusted
 * contracts are left out.
 */
describe("Handover: VSC holders on the bound whitelist oracle (Task 4.16)", function () {
  const e = ethers.parseEther;
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let o: any, wl: any, token: any, rules: any, alice: any, bob: any;

  beforeEach(async function () {
    f = await handoverFixture();
    ({ token, complianceRules: rules } = f.c);
    wl = f.args.oracles[0];
    alice = f.proposer;
    bob = f.voters[0];
    await token.addAgent(f.deployer.address);
    await token.mint(alice.address, e("1000"));
    await rules.setWhitelistOracle(token.target, wl.target);
    o = { ...f.args, log: () => {} };
  });

  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);

  it("OracleOnly: an unlisted holder is refused; listed at its tier it passes", async function () {
    await expect(preflightHolders(o, warn)).to.be.rejectedWith(
      /Handover: whitelist oracle .* OracleOnly and 1 current holder\(s\) are not listed/,
    );
    const [[label, ok]] = await holderLines(o, []);
    expect(ok).to.equal(false);
    expect(label).to.include(alice.address).and.include("unlisted");
    await wl.addToWhitelist(alice.address, 1, 0, "kyc");
    const s = await preflightHolders(o, warn);
    expect(s.holders.map((h: any) => h.address)).to.deep.equal([alice.address]);
    const [[label2, ok2]] = await holderLines(o, []);
    expect(ok2).to.equal(true);
    expect(label2).to.include(
      "every one of 1 VSC holder(s) is listed at its tier",
    );
  });

  it("a holder listed below its investor type's tier is refused in OracleOnly and Either", async function () {
    const itr = f.c.investorTypeRegistry;
    await token.setInvestorTypeRegistry(itr.target);
    await itr.authorizeToken(token.target, true);
    await itr.assignInvestorType(alice.address, 1); // Retail: tier 2
    await wl.addToWhitelist(alice.address, 1, 0, "short");
    await expect(preflightHolders(o, warn)).to.be.rejectedWith(
      /below the tier their investor type requires .*tier 1 < 2/,
    );
    await rules.setPrivacyManager(token.target, f.c.privacyManager.target);
    await rules.setWhitelistMode(token.target, 2); // Either
    await expect(preflightHolders(o, warn)).to.be.rejectedWith(/tier 1 < 2/);
    const [[, ok]] = await holderLines(o, []);
    expect(ok).to.equal(false);
    await wl.addToWhitelist(alice.address, 2, 0, "at tier");
    const s = await preflightHolders(o, warn);
    expect(s.holders[0].ok).to.equal(true);
  });

  it("Either: an unlisted holder is a warning, not a refusal; ZkOnly reads nothing", async function () {
    // bob receives VSC while no oracle gates the mint, then stays unlisted.
    await rules.setWhitelistOracle(token.target, ethers.ZeroAddress);
    await token.mint(bob.address, e("10"));
    await rules.setWhitelistOracle(token.target, wl.target);
    await wl.addToWhitelist(alice.address, 1, 0, "kyc");
    await rules.setPrivacyManager(token.target, f.c.privacyManager.target);
    await rules.setWhitelistMode(token.target, 2); // Either
    const seen: string[] = [];
    const s = await preflightHolders(o, (w: string) => seen.push(w));
    expect(s.mode).to.equal("Either");
    expect(seen).to.have.length(1);
    expect(seen[0]).to.include(bob.address).and.include("not listed");
    const completion: string[] = [];
    const [[, ok]] = await holderLines(o, completion);
    expect(ok).to.equal(true);
    expect(completion[0]).to.include(bob.address);
    await rules.setWhitelistMode(token.target, 1); // ZkOnly
    expect((await preflightHolders(o, warn)).mode).to.equal("ZkOnly");
    const [[label, okZk]] = await holderLines(o, []);
    expect(okZk).to.equal(true);
    expect(label).to.include("ZkOnly");
  });

  it("no oracle bound: one informational line; trusted contracts are not holders", async function () {
    await rules.setWhitelistOracle(token.target, ethers.ZeroAddress);
    expect(await preflightHolders(o, warn)).to.equal(null);
    const [[label, ok]] = await holderLines(o, []);
    expect(ok).to.equal(true);
    expect(label).to.include("no whitelist oracle bound to VSC");
    // A trusted contract holding VSC is not a holder the whitelist reads.
    const w = await (
      await ethers.getContractFactory("MultiSigWallet")
    ).deploy(f.ops.address, alice.address, token.target);
    await rules.addTrustedContract(token.target, w.target);
    await token.connect(alice).transfer(w.target, e("1"));
    await rules.setWhitelistOracle(token.target, wl.target);
    const s = await holderStanding(o);
    expect(s.holders.map((h: any) => h.address)).to.deep.equal([alice.address]);
  });
});
