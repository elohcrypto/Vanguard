import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { attest, configureKyc } from "../helpers/kyc";

/**
 * Task 2E.1 (deep-review G6): ComplianceRules.trustedContracts may only hold
 * addresses with code. A trusted party skips its own identity check, never
 * the counterparty's, so a trusted-to-anything transfer always means
 * "contract exempt, human counterparty checked".
 */
describe("Trusted contracts must be contracts", function () {
  let owner: SignerWithAddress,
    payer: SignerWithAddress,
    payee: SignerWithAddress,
    wallet: SignerWithAddress;
  let idReg: any, rules: any, token: any, escrow: string, escrow2: string;
  const E = (n: number) => ethers.parseEther(String(n));

  const deployStub = async () => {
    const stub = await (
      await ethers.getContractFactory("MockToken")
    ).deploy("Stub", "STB", 0);
    return stub.getAddress();
  };

  // A trusted contract sending VSC: impersonate the stub so it can sign.
  const asContract = async (addr: string) => {
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [addr],
    });
    await network.provider.send("hardhat_setBalance", [
      addr,
      "0xDE0B6B3A7640000",
    ]);
    return ethers.getSigner(addr);
  };

  beforeEach(async function () {
    [owner, payer, payee, wallet] = await ethers.getSigners();

    idReg = await (
      await ethers.getContractFactory("IdentityRegistry")
    ).deploy();
    rules = await (
      await ethers.getContractFactory("ComplianceRules")
    ).deploy(owner.address, [840], [643]);
    token = await (
      await ethers.getContractFactory("Token")
    ).deploy(
      "Vanguard",
      "VSC",
      await idReg.getAddress(),
      await rules.getAddress(),
    );
    await rules.setTokenIdentityRegistry(
      await token.getAddress(),
      await idReg.getAddress(),
    );
    await idReg.addAgent(owner.address);

    const kycIssuer = await (
      await ethers.getContractFactory("ClaimIssuer")
    ).deploy(owner.address, "KYC Issuer", "Trusted KYC attestations");
    await configureKyc(idReg, await kycIssuer.getAddress());

    const OID = await ethers.getContractFactory("OnchainID");
    for (const who of [payer, payee]) {
      const id = await OID.deploy(who.address);
      await idReg.registerIdentity(who.address, await id.getAddress(), 840);
      await attest(kycIssuer, owner, await id.getAddress());
    }
    await token.mint(payer.address, E(1000));

    escrow = await deployStub();
    escrow2 = await deployStub();
  });

  it("refuses a wallet", async function () {
    await expect(rules.addTrustedContract(wallet.address)).to.be.revertedWith(
      "ComplianceRules: not a contract",
    );
    expect(await rules.isTrustedContract(wallet.address)).to.equal(false);
  });

  it("refuses a wallet carrying an EIP-7702 delegation", async function () {
    // Delegation indicator: 0xef0100 || 20-byte delegate address (23 bytes).
    const indicator = "0xef0100" + escrow.slice(2).toLowerCase();
    await network.provider.send("hardhat_setCode", [wallet.address, indicator]);
    expect(await ethers.provider.getCode(wallet.address)).to.equal(indicator);
    await expect(rules.addTrustedContract(wallet.address)).to.be.revertedWith(
      "ComplianceRules: delegated wallet",
    );
    expect(await rules.isTrustedContract(wallet.address)).to.equal(false);
    // A real contract still passes.
    await rules.addTrustedContract(escrow);
    expect(await rules.isTrustedContract(escrow)).to.equal(true);
    await network.provider.send("hardhat_setCode", [wallet.address, "0x"]);
  });

  it("accepts a deployed contract", async function () {
    await expect(rules.addTrustedContract(escrow))
      .to.emit(rules, "TrustedContractAdded")
      .withArgs(escrow);
    expect(await rules.isTrustedContract(escrow)).to.equal(true);
  });

  it("removes a trusted contract", async function () {
    await rules.addTrustedContract(escrow);
    await expect(rules.removeTrustedContract(escrow))
      .to.emit(rules, "TrustedContractRemoved")
      .withArgs(escrow);
    expect(await rules.isTrustedContract(escrow)).to.equal(false);
  });

  it("moves tokens between two trusted contracts with no identity", async function () {
    await rules.addTrustedContract(escrow);
    await rules.addTrustedContract(escrow2);
    expect(await idReg.identity(escrow)).to.equal(ethers.ZeroAddress);
    expect(await idReg.identity(escrow2)).to.equal(ethers.ZeroAddress);

    await token.connect(payer).transfer(escrow, E(100));
    await token.connect(await asContract(escrow)).transfer(escrow2, E(40));
    expect(await token.balanceOf(escrow2)).to.equal(E(40));
  });

  it("after an escrow settles, an unverified payer cannot pay the payee", async function () {
    await rules.addTrustedContract(escrow);

    // Verified payer funds the escrow; the escrow pays the verified payee.
    await token.connect(payer).transfer(escrow, E(100));
    await token
      .connect(await asContract(escrow))
      .transfer(payee.address, E(100));
    expect(await token.balanceOf(payee.address)).to.equal(E(100));

    // While verified, the payer may pay the payee directly.
    await token.connect(payer).transfer(payee.address, E(10));

    // Identity gone: trust on the escrow never covers the human pair.
    await idReg.deleteIdentity(payer.address);
    await expect(
      token.connect(payer).transfer(payee.address, E(10)),
    ).to.be.revertedWith("Sender not verified");
    // Nor can the payer route through the trusted contract: the trusted
    // path checks the human counterparty.
    await expect(
      token.connect(payer).transfer(escrow, E(10)),
    ).to.be.revertedWith("Compliance check failed");
    expect(await token.balanceOf(payee.address)).to.equal(E(110));
  });

  it("a trusted contract cannot pay an unverified payee", async function () {
    await rules.addTrustedContract(escrow);
    await token.connect(payer).transfer(escrow, E(100));
    expect(await idReg.identity(wallet.address)).to.equal(ethers.ZeroAddress);
    await expect(
      token.connect(await asContract(escrow)).transfer(wallet.address, E(10)),
    ).to.be.revertedWith("Compliance check failed");
    expect(await token.balanceOf(wallet.address)).to.equal(0n);
  });
});
