// Review U2 round 2 (the swarm's surviving mutants M14, M15, M16): an
// identity is the wallet's own only when it is owned by the wallet, its
// one MANAGEMENT key is the wallet's, and it is pinned to the factory's
// recovery manager; each case breaks exactly one of the three.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const { onboard } = require("../../demo/utils/Onboard");
const REFUSED =
  /factory identity 0x[0-9a-fA-F]{40} of 0x[0-9a-fA-F]{40} is not its own .*: not adopted/;

describe("U2 ownIdentity: owner, one MANAGEMENT key, the pinned manager", function () {
  this.timeout(600000);
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;
  let W: any, W2: any;
  const keyOf = (a: string) =>
    ethers.keccak256(ethers.solidityPacked(["address"], [a]));

  beforeEach(async function () {
    f = await handoverFixture();
    const byName: Record<string, any> = {
      onchainIDFactory: f.factory,
      identityRegistry: f.c.identityRegistry,
      complianceRules: f.c.complianceRules,
      digitalToken: f.c.token,
      kycIssuer: f.kycIssuer,
      amlIssuer: f.kycIssuer,
    };
    const signers = await ethers.getSigners();
    state = { signers, getContract: (n: string) => byName[n] };
    [W, W2] = [signers[9], signers[10]];
  });

  /** W's factory identity, not registered, no claims. */
  async function identityOfW() {
    const r = await onboard(state, W.address, {
      register: false,
      attest: false,
      cache: false,
    });
    return ethers.getContractAt("OnchainID", r.identity);
  }

  const refused = async () => {
    let err = "";
    await onboard(state, W.address).catch((e: any) => (err = e.message));
    expect(err).to.match(REFUSED);
    expect(await f.c.identityRegistry.identity(W.address)).to.equal(
      ethers.ZeroAddress,
    );
  };

  it("M14: W's key the only MANAGEMENT key, but W2 the owner: refused", async function () {
    const id = await identityOfW();
    await id.connect(W).transferOwnership(W2.address);
    await id.connect(W2).acceptOwnership();
    await id.connect(W2).addKey(keyOf(W.address), 1, 1);
    await id.connect(W2).removeKey(keyOf(W2.address), 1);
    expect(await id.getKeysByPurpose(1)).to.deep.equal([keyOf(W.address)]);
    await refused();
  });

  it("M15: pinned to a recovery manager the factory no longer names: refused", async function () {
    await identityOfW();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await f.factory.setRecoveryManager(await km.getAddress());
    await refused();
  });

  it("M16: a second MANAGEMENT key beside W's: refused", async function () {
    const id = await identityOfW();
    await id.connect(W).addKey(keyOf(W2.address), 1, 1);
    await refused();
  });
});
