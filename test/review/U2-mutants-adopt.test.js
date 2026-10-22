// Review U2 round 3 (the swarm's surviving mutants G15 and G16): options 3
// and 24 adopt the identity they just created only when it is the
// wallet's own (Onboard.adoptOwn, review D2-6); one whose ownership moved
// to another key before the flow reads it is refused by name and nothing
// is recorded for it.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, baseStack, swap } = require("../helpers/deployFlows");

const REFUSED =
  "factory identity 0x[0-9a-fA-F]{40} of 0x[0-9a-fA-F]{40} is not its own .*: not adopted";

/** `real`, each identity it deploys handed to `to` before the flow reads it. */
function movingFactory(real, to) {
  const wrap = (f) =>
    swap(f, "deployOnchainID", async (owner, salt) => {
      const tx = await f.deployOnchainID(owner, salt);
      await tx.wait();
      const id = await ethers.getContractAt(
        "OnchainID",
        await f.getIdentityByOwner(owner),
      );
      const from = await ethers.getSigner(owner);
      await (await id.connect(from).transferOwnership(to.address)).wait();
      await (await id.connect(to).acceptOwnership()).wait();
      return tx;
    });
  return swap(wrap(real), "connect", (s) => wrap(real.connect(s)));
}

const answers =
  (...a) =>
  async () =>
    a.shift();

describe("U2 options 3 and 24 refuse an identity that is not the wallet's own (G15, G16)", function () {
  this.timeout(300000);

  // The modules load in the tests, not with the file: review D-6's test
  // drops ChainTime from the require cache, and a flow loaded before that
  // keeps a copy KeyLifecycleFlow's test cannot stub.
  it("G15: option 3 refuses the identity it created once its ownership moved", async function () {
    const OnchainIDModule = require("../../demo/modules/OnchainIDModule");
    const { state } = await baseStack();
    const [W, W2] = [state.signers[13], state.signers[14]];
    const real = state.getContract("onchainIDFactory");
    state.setContract("onchainIDFactory", movingFactory(real, W2));
    const m = new OnchainIDModule(
      state,
      new EnhancedLogger(),
      answers("1", "13"),
    );
    const [, out] = await capture(() => m.createOnchainID());
    const text = out.join("\n");
    expect(text).to.match(new RegExp(`OnchainID creation failed: ${REFUSED}`));
    expect(text).to.not.contain("ONCHAINID CREATED SUCCESSFULLY");
    const id = await real.getIdentityByOwner(W.address);
    expect(id).to.not.equal(ethers.ZeroAddress);
    expect(state.identities.has(id)).to.equal(false);
  });

  it("G16: option 24 refuses a non-compliant user's identity once its ownership moved", async function () {
    const TokenModule = require("../../demo/modules/TokenModule");
    const SignerManager = require("../../demo/utils/SignerManager");
    const { state, deployer } = await baseStack();
    const real = state.getContract("onchainIDFactory");
    state.setContract(
      "onchainIDFactory",
      movingFactory(real, state.signers[15]),
    );
    const m = new TokenModule(
      state,
      new EnhancedLogger(),
      answers("Mallory", "sanctioned"),
      deployer,
      new SignerManager(state),
    );
    const [, out] = await capture(() => m.createNonCompliantNormalUser());
    const text = out.join("\n");
    expect(text).to.match(new RegExp(`User creation failed: ${REFUSED}`));
    expect(text).to.not.contain("NON-COMPLIANT NORMAL USER CREATED");
    expect(state.normalUsers.size).to.equal(0);
  });
});
