// Review D2-6 (ported from the reviewer's P-D2-6.test.ts, inverted):
// Onboard.onboard adopts factory.getIdentityByOwner(wallet) only after
// the checks deployIdentity applies after a lost race (the factory's
// own, owned by the wallet, whose one MANAGEMENT key is the wallet's,
// pinned to the factory's recovery manager). ownerToIdentity is set at
// creation only, so after an ownership move it names an identity the
// wallet no longer owns: that one is refused, never adopted.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const { onboard } = require("../../demo/utils/Onboard");
const REFUSED =
  /factory identity 0x[0-9a-fA-F]{40} of 0x[0-9a-fA-F]{40} is not its own .*: not adopted/;

describe("D2-6 onboard refuses the factory's stale ownerToIdentity", function () {
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

  /** W gets a factory identity (nothing else), then moves its ownership to W2. */
  async function createThenMove(register: boolean) {
    const r = await onboard(
      state,
      W.address,
      register
        ? { attest: false, cache: false }
        : { register: false, attest: false, cache: false },
    );
    const id = await ethers.getContractAt("OnchainID", r.identity);
    await id.connect(W).transferOwnership(W2.address);
    await id.connect(W2).acceptOwnership();
    expect(await f.factory.getIdentityByOwner(W.address)).to.equal(r.identity); // stale
    return id;
  }

  it("A: the default onboard of a wallet whose identity moved is refused by name", async function () {
    await createThenMove(false);
    let err = "";
    await onboard(state, W.address).catch((e: any) => (err = e.message));
    expect(err).to.match(REFUSED);
    expect(await f.c.identityRegistry.identity(W.address)).to.equal(
      ethers.ZeroAddress,
    );
  });

  it("B: onboard(W, {register:false}) issues no claim on the identity W2 owns", async function () {
    const id = await createThenMove(false);
    let err = "";
    await onboard(state, W.address, { register: false, cache: false }).catch(
      (e: any) => (err = e.message),
    );
    expect(err).to.match(REFUSED);
    expect(await id.getClaimIdsByTopic(6)).to.have.length(0);
  });

  it("C: an ACTION key left on the moved identity does not register W to it", async function () {
    const id = await createThenMove(false);
    await id.connect(W2).addKey(keyOf(W.address), 2, 1);
    let err = "";
    await onboard(state, W.address).catch((e: any) => (err = e.message));
    expect(err).to.match(REFUSED);
    expect(await f.c.identityRegistry.identity(W.address)).to.equal(
      ethers.ZeroAddress,
    );
  });

  it("D: a recovered wallet (the registry moved its identity) is refused by name", async function () {
    await createThenMove(true);
    await f.c.identityRegistry
      .connect(f.deployer)
      .moveIdentity(W.address, W2.address);
    let err = "";
    await onboard(state, W.address).catch((e: any) => (err = e.message));
    expect(err).to.match(REFUSED);
  });

  it("E: a wallet's own factory identity is still adopted", async function () {
    const first = await onboard(state, W.address, {
      register: false,
      attest: false,
      cache: false,
    });
    const r = await onboard(state, W.address, { attest: false, cache: false });
    expect([r.created, r.registered, r.identity]).to.deep.equal([
      false,
      true,
      first.identity,
    ]);
  });
});
