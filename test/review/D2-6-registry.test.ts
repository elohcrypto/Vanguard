// Review D2-6, round 2 (ported from the swarm's attack-u2-onboard,
// inverted): the identity the IdentityRegistry maps a wallet to is
// adopted only when it is the wallet's own (ownIdentity, as on the
// factory path): after its ownership moved to another key the registry
// still names it, and onboarding the wallet is refused by name, no claim
// issued on it.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";

const { onboard } = require("../../demo/utils/Onboard");

describe("D2-6 onboard refuses a registry identity the wallet no longer owns", function () {
  this.timeout(600000);

  it("W registered to X, X then owned by W2: onboard(W) is refused, X gets no claim", async function () {
    const f = await handoverFixture();
    const byName: Record<string, any> = {
      onchainIDFactory: f.factory,
      identityRegistry: f.c.identityRegistry,
      complianceRules: f.c.complianceRules,
      digitalToken: f.c.token,
      kycIssuer: f.kycIssuer,
      amlIssuer: f.kycIssuer,
    };
    const signers = await ethers.getSigners();
    const state: any = { signers, getContract: (n: string) => byName[n] };
    const [W, W2] = [signers[9], signers[10]];
    const first = await onboard(state, W.address, {
      attest: false,
      cache: false,
    });
    const id = await ethers.getContractAt("OnchainID", first.identity);
    await id.connect(W).transferOwnership(W2.address);
    await id.connect(W2).acceptOwnership();
    expect(await f.c.identityRegistry.identity(W.address)).to.equal(
      first.identity,
    );
    let err = "";
    await onboard(state, W.address).catch((e: any) => (err = e.message));
    expect(err).to.match(
      /registry identity 0x[0-9a-fA-F]{40} of 0x[0-9a-fA-F]{40} is not its own .*: not adopted/,
    );
    expect(await id.getClaimIdsByTopic(6)).to.have.length(0);
  });
});
