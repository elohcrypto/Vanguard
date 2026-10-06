import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Plan v2 Task 4.5: demo option 5a (no prompts) and option 5 -> 1 (the
 * prompted removal) remove a key through removeKeyWithProof with the
 * holder's signature over getRemoveKeyMessage. Read back from chain.
 */
describe("Key removal flow (demo options 5a, 5 -> 1)", function () {
  this.timeout(300_000);

  const ACTION = 2;
  const k = (a: string) => ethers.solidityPackedKeccak256(["address"], [a]);
  let state: any;
  let flow: any;
  let logged: string[];

  async function quiet(fn: () => Promise<any>): Promise<any> {
    const orig = console.log;
    console.log = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      return await fn();
    } finally {
      console.log = orig;
    }
  }

  beforeEach(async function () {
    const ContractDeployer = require("../../demo/core/ContractDeployer");
    const DemoState = require("../../demo/core/DemoState");
    const { EnhancedLogger } = require("../../demo/logging");
    flow = require("../../demo/utils/KeyRemovalFlow");
    state = new DemoState();
    if (state.initialize) await state.initialize();
    state.signers = await ethers.getSigners();
    logged = [];
    const deployer = new ContractDeployer(state, new EnhancedLogger());
    await quiet(() => deployer.deployAllContracts());
  });

  it("option 5a removes a throwaway key with its proof and refuses a stranger", async function () {
    const r = await quiet(() => flow.runRemovalDemo(state));
    const out = logged.join("\n");
    expect(r, out).to.be.an("object");
    expect(r.removed, out).to.equal(true);
    expect(r.wrongRefused, out).to.equal(true);
    expect(out).to.include("Method: removeKeyWithProof");
    const id = await ethers.getContractAt("OnchainID", r.identity);
    expect(await id.owner()).to.equal(state.signers[1].address);
    expect(await id.keyHasPurpose(r.key, ACTION)).to.equal(false);
    expect((await id.getKey(r.key)).revokedAt).to.be.gt(0n);
  });

  it("option 5 -> 1 removes a wallet's key with that wallet's signature", async function () {
    const OnchainIDModule = require("../../demo/modules/OnchainIDModule");
    const s = state.signers;
    const factory = state.getContract("onchainIDFactory");
    await factory
      .connect(s[1])
      .deployOnchainID(s[1].address, ethers.randomBytes(32), {
        value: await factory.deploymentFee(),
      });
    const idAddr = await factory.getIdentityByOwner(s[1].address);
    const id = await ethers.getContractAt("OnchainID", idAddr);
    await id.connect(s[1]).addKey(k(s[9].address), ACTION, 1);
    const index = (await id.getKeysByPurpose(ACTION)).indexOf(k(s[9].address));
    const answers = ["yes", "2", String(index), "1", s[9].address];
    const mod = new OnchainIDModule(state, null, async () => answers.shift());
    await quiet(() =>
      mod.removeCompromisedKey(id, { address: idAddr, owner: s[1].address }),
    );
    const out = logged.join("\n");
    expect(answers, out).to.have.length(0);
    expect(out).to.include("Method: removeKeyWithProof");
    expect(out).to.include("Key removed successfully!");
    expect(await id.keyHasPurpose(k(s[9].address), ACTION)).to.equal(false);
    expect((await id.getKey(k(s[9].address))).revokedAt).to.be.gt(0n);
  });
});
