import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// updateWhitelistStatus / updateBlacklistStatus were external with no caller
// check; digests carried no nonce, chain id or contract address; the consensus
// loop never rejected duplicate signatures (one signature passed twice was
// "consensus"); and the emergency gate was inverted (`severity < 4` required an
// emergency oracle, so severity >= 4 needed none).
describe("UTXOCompliance list updates: bound, nonced, distinct-signer, caller-gated", () => {
  let utxo: any, oracleManager: any;
  let owner: SignerWithAddress, o1: SignerWithAddress, o2: SignerWithAddress, o3: SignerWithAddress;
  let user: SignerWithAddress, rando: SignerWithAddress;
  let chainId: bigint, utxoAddr: string;

  beforeEach(async () => {
    [owner, o1, o2, o3, user, rando] = await ethers.getSigners();
    oracleManager = await (await ethers.getContractFactory("MockOracleManager")).deploy();
    const ir = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
    const cr = await (await ethers.getContractFactory("MockComplianceRegistry")).deploy();
    const validator = await (await ethers.getContractFactory("ComplianceValidator")).deploy(
      await oracleManager.getAddress(), await ir.getAddress(), await cr.getAddress(), owner.address);
    const rules = await (await ethers.getContractFactory("ComplianceRules")).deploy(owner.address, [840], []);
    utxo = await (await ethers.getContractFactory("UTXOCompliance")).deploy(
      await validator.getAddress(), await oracleManager.getAddress(), await rules.getAddress(), owner.address);
    for (const o of [o1, o2, o3]) await oracleManager.registerOracle(o.address, "o");
    chainId = (await ethers.provider.getNetwork()).chainId;
    utxoAddr = await utxo.getAddress();
  });

  const WL_TAG = ethers.keccak256(ethers.toUtf8Bytes("UTXOCompliance.updateWhitelistStatus"));
  const BL_TAG = ethers.keccak256(ethers.toUtf8Bytes("UTXOCompliance.updateBlacklistStatus"));
  async function wlSig(s: SignerWithAddress, u: string, w: boolean, tier: number, nonce: bigint) {
    const h = ethers.solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "address", "bool", "uint8", "uint256"], [WL_TAG, utxoAddr, chainId, u, w, tier, nonce]);
    return s.signMessage(ethers.getBytes(h));
  }
  async function blSig(s: SignerWithAddress, u: string, b: boolean, sev: number, reason: string, nonce: bigint) {
    const h = ethers.solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "address", "bool", "uint8", "string", "uint256"], [BL_TAG, utxoAddr, chainId, u, b, sev, reason, nonce]);
    return s.signMessage(ethers.getBytes(h));
  }

  it("whitelist: two DISTINCT oracle signatures, submitted by an oracle, succeed and bump the nonce", async () => {
    const n = await utxo.listNonce(user.address);
    const sigs = [await wlSig(o1, user.address, true, 2, n), await wlSig(o2, user.address, true, 2, n)];
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.emit(utxo, "WhitelistStatusChanged");
    expect((await utxo.getWhitelistStatus(user.address)).tier).to.equal(2);
    expect(await utxo.listNonce(user.address)).to.equal(n + 1n);
  });

  it("whitelist: the same signature twice is NOT consensus", async () => {
    const n = await utxo.listNonce(user.address);
    const s = await wlSig(o1, user.address, true, 2, n);
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, [s, s]))
      .to.be.revertedWithCustomError(utxo, "DuplicateOracleSignature");
  });

  it("whitelist: a used signature set cannot be replayed (nonce)", async () => {
    const n = await utxo.listNonce(user.address);
    const sigs = [await wlSig(o1, user.address, true, 2, n), await wlSig(o2, user.address, true, 2, n)];
    await utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs);
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.be.revertedWith("Invalid oracle signature");
  });

  it("whitelist: a non-oracle caller is rejected even with valid signatures", async () => {
    const n = await utxo.listNonce(user.address);
    const sigs = [await wlSig(o1, user.address, true, 2, n), await wlSig(o2, user.address, true, 2, n)];
    await expect(utxo.connect(rando).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.be.revertedWith("Unauthorized oracle");
  });

  it("whitelist: a signature over the OLD unbound digest is rejected", async () => {
    const old = ethers.solidityPackedKeccak256(["address", "bool", "uint8"], [user.address, true, 2]);
    const sigs = [await o1.signMessage(ethers.getBytes(old)), await o2.signMessage(ethers.getBytes(old))];
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.be.revertedWith("Invalid oracle signature");
  });

  it("blacklist: a single non-emergency oracle cannot blacklist at ANY severity", async () => {
    // MockOracleManager has no emergency oracles, so every single-signature
    // path must fail — including severity 4, which the inverted gate let through.
    for (const sev of [1, 4, 5]) {
      const n = await utxo.listNonce(user.address);
      const s = await blSig(o1, user.address, true, sev, "r", n);
      await expect(utxo.connect(o1).updateBlacklistStatus(user.address, true, sev, "r", s))
        .to.be.revertedWith("Non-emergency oracle cannot blacklist without consensus");
    }
    expect((await utxo.getBlacklistStatus(user.address)).isBlacklisted).to.equal(false);
  });

  it("blacklist: an EMERGENCY oracle can single-sign at low and high severity, once per nonce", async () => {
    await oracleManager.setEmergencyOracle(o3.address, true);
    for (const sev of [1, 4]) {
      const n = await utxo.listNonce(user.address);
      const s = await blSig(o3, user.address, true, sev, "r", n);
      await expect(utxo.connect(o3).updateBlacklistStatus(user.address, true, sev, "r", s))
        .to.emit(utxo, "BlacklistStatusChanged");
      expect((await utxo.getBlacklistStatus(user.address)).severity).to.equal(sev);
      // replay of the consumed signature fails
      await expect(utxo.connect(o3).updateBlacklistStatus(user.address, true, sev, "r", s))
        .to.be.revertedWith("Invalid oracle signature");
    }
  });

  // Qodo on PR #10 (1): without an operation tag the whitelist(tier 4) and
  // blacklist(severity 4, reason "") payloads packed to identical bytes, so an
  // emergency oracle's pending WHITELIST signature could be replayed as a
  // blacklist update by any other oracle, consuming the shared nonce.
  it("an emergency oracle's whitelist signature cannot be consumed as a blacklist update", async () => {
    await oracleManager.setEmergencyOracle(o3.address, true);
    const n = await utxo.listNonce(user.address);
    const wl = await wlSig(o3, user.address, true, 4, n); // approve tier 4
    await expect(utxo.connect(o1).updateBlacklistStatus(user.address, true, 4, "", wl))
      .to.be.revertedWith("Invalid oracle signature");
    expect((await utxo.getBlacklistStatus(user.address)).isBlacklisted).to.equal(false);
    expect(await utxo.listNonce(user.address)).to.equal(n); // nothing consumed
  });

  // Qodo on PR #10 (2): pausing clears only `active`; registration alone must
  // not be enough for the caller, a whitelist signer, or the emergency signer.
  it("a paused oracle can neither call nor sign", async () => {
    const n = await utxo.listNonce(user.address);
    const sigs = [await wlSig(o1, user.address, true, 2, n), await wlSig(o2, user.address, true, 2, n)];
    await oracleManager.deactivateOracle(o2.address);
    await expect(utxo.connect(o2).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.be.revertedWith("Unauthorized oracle");
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.be.revertedWithCustomError(utxo, "InactiveOracleSignature").withArgs(o2.address);
    await oracleManager.setEmergencyOracle(o2.address, true);
    const bl = await blSig(o2, user.address, true, 5, "r", n);
    await expect(utxo.connect(o1).updateBlacklistStatus(user.address, true, 5, "r", bl))
      .to.be.revertedWithCustomError(utxo, "InactiveOracleSignature").withArgs(o2.address);
    // re-activated: the same whitelist set is accepted
    await oracleManager.activateOracle(o2.address);
    await expect(utxo.connect(o1).updateWhitelistStatus(user.address, true, 2, sigs))
      .to.emit(utxo, "WhitelistStatusChanged");
  });

  it("blacklist: caller must be an oracle", async () => {
    const n = await utxo.listNonce(user.address);
    const s = await blSig(o1, user.address, true, 4, "r", n);
    await expect(utxo.connect(rando).updateBlacklistStatus(user.address, true, 4, "r", s))
      .to.be.revertedWith("Unauthorized oracle");
  });
});
