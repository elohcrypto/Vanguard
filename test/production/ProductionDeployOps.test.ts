import { expect } from "chai";
import { ethers } from "hardhat";
import { OnchainID } from "../../typechain-types";

// Plan v2 Task 4.2: the production deploy authorizes KeyManager on the ops
// identity when the deployer owns it, else prints the call. Since Task 5.7
// DeployProduction.ts calls configureKeyManager with the config's
// "opsIdentity" after the stack is deployed (scripts/ci/deploy-drive.sh
// runs the CLI end to end).
describe("🔐 Production deploy: KeyManager on the ops identity (4.2)", function () {
  it("authorizes a deployer-owned ops identity; prints the call for another owner", async function () {
    const {
      authorizeKeyManagerOnOps,
      configureKeyManager,
    } = require("../../scripts/production/opsKeyManager");
    const signers = await ethers.getSigners();
    const [deployer, opsKey] = [signers[0], signers[5]];
    const OID = await ethers.getContractFactory("OnchainID");
    const ownOps = await OID.deploy(deployer.address);
    const keyManager = await (
      await ethers.getContractFactory("KeyManager")
    ).deploy();
    const quiet = console.log;
    const out: string[] = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    let r: any;
    try {
      r = await configureKeyManager(
        keyManager,
        deployer,
        await ownOps.getAddress(),
        {},
      );
    } finally {
      console.log = quiet;
    }
    const km = await keyManager.getAddress();
    expect(r.recoveryTimelock).to.equal(await keyManager.RECOVERY_TIMELOCK());
    expect(r.opsKeyManager).to.deep.equal({
      opsIdentity: await ownOps.getAddress(),
      authorized: true,
      pending: null,
    });
    expect(await ownOps.authorizedManagers(km)).to.equal(true);
    expect(await ownOps.recoveryManager()).to.equal(km); // pinned (4.11)
    // An ops identity the ops key owns: nothing sent, both calls printed.
    const theirs = await OID.deploy(opsKey.address);
    const tAddr = await theirs.getAddress();
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    let r2: any;
    try {
      r2 = await authorizeKeyManagerOnOps(km, deployer, tAddr);
    } finally {
      console.log = quiet;
    }
    const pending = `OnchainID(${tAddr}).pinRecoveryManager(${km}) from the identity owner ${opsKey.address}; OnchainID(${tAddr}).authorizeManager(${km}) from the identity owner ${opsKey.address}`;
    expect(r2).to.deep.equal({
      opsIdentity: tAddr,
      authorized: false,
      pending,
    });
    expect(out.join("\n")).to.contain(
      `The ops key must send: OnchainID(${tAddr}).authorizeManager(${km}) from the identity owner ${opsKey.address}`,
    );
    expect(out.join("\n")).to.contain(
      `The ops key must also send: OnchainID(${tAddr}).pinRecoveryManager(${km})`,
    );
    expect(await theirs.recoveryManager()).to.equal(ethers.ZeroAddress);
    expect(await theirs.authorizedManagers(km)).to.equal(false);
    // The printed call is the one that works, and only from the owner.
    await expect(theirs.authorizeManager(km)).to.be.revertedWith(
      "OnchainID: Only owner can authorize managers",
    );
    await theirs.connect(opsKey).authorizeManager(km);
    expect(await theirs.authorizedManagers(km)).to.equal(true);
  });

  it("OPS_IDENTITY unset prints the call; an address with no code is refused", async function () {
    const {
      authorizeKeyManagerOnOps,
    } = require("../../scripts/production/opsKeyManager");
    const [deployer, stranger] = await ethers.getSigners();
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    const kmA = await km.getAddress();
    const quiet = console.log;
    const out: string[] = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    let r: any;
    try {
      r = await authorizeKeyManagerOnOps(kmA, deployer, undefined);
    } finally {
      console.log = quiet;
    }
    const pending = `OnchainID(<ops identity>).authorizeManager(${kmA}) from the identity owner <ops key>`;
    expect(r).to.deep.equal({ opsIdentity: null, authorized: false, pending });
    expect(out.join("\n")).to.contain("OPS_IDENTITY not set");
    await expect(
      authorizeKeyManagerOnOps(kmA, deployer, stranger.address),
    ).to.be.rejectedWith(`OPS_IDENTITY ${stranger.address} has no code`);
    await expect(
      authorizeKeyManagerOnOps(kmA, deployer, "not-an-address"),
    ).to.be.rejectedWith("is not an address");
  });
});
