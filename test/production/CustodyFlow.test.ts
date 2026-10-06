import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import { walletCodeHash } from "../helpers/registrars";

const Custody = require("../../demo/utils/CustodyFlow");

/**
 * Plan v2 Task 4.3 (D13 b): option 23's custody steps, through the module
 * the demo calls (demo/utils/CustodyFlow.js), on the handover fixture:
 * deploy (bank = ops wallet 10, registrar, owner ops), request, wallet,
 * lock (the tokens move), approve, downgrade (2-of-2 release); and the
 * 2E.1 interim undone by option 62 (a keyless placeholder fee wallet is
 * retired and its identity deleted).
 */
describe("CustodyFlow: option 23 on the MultiSigWallet (Task 4.3)", function () {
  let f: Awaited<ReturnType<typeof handoverFixture>>;
  let state: any;
  const quiet = () => {};

  beforeEach(async function () {
    f = await handoverFixture();
    const byName: Record<string, any> = {
      digitalToken: f.c.token,
      complianceRules: f.c.complianceRules,
      identityRegistry: f.c.identityRegistry,
      investorTypeRegistry: f.c.investorTypeRegistry,
      vanguardGovernance: f.c.governance,
    };
    state = {
      signers: await ethers.getSigners(),
      getContract: (n: string) => byName[n],
      setContract: (n: string, c: any) => {
        byName[n] = c;
      },
    };
  });

  it("deploys the manager as ops' registrar with demo lock amounts", async function () {
    const m = await Custody.deployCustody(state, quiet);
    const ops = state.signers[10];
    const vsc = await f.c.token.getAddress();
    expect(await m.bank()).to.equal(ops.address);
    expect(await m.owner()).to.equal(ops.address);
    expect(
      await f.c.complianceRules.trustedRegistrars(vsc, await m.getAddress()),
    ).to.equal(await walletCodeHash("MultiSigWallet"));
    expect(
      await f.c.investorTypeRegistry.isComplianceOfficer(await m.getAddress()),
    ).to.equal(true);
    const cap = (await f.c.investorTypeRegistry.getInvestorTypeConfig(0))
      .maxTransferAmount;
    expect(await m.lockRequirements(3)).to.equal(cap);
    expect(await m.lockRequirements(1)).to.equal(cap / 4n);
    // Recorded and reused: a second call deploys nothing.
    expect(await Custody.deployCustody(state, quiet)).to.equal(m);
  });

  it("request, wallet, lock, approve, downgrade: tokens move, both sign", async function () {
    const { deployer, proposer: alice } = f;
    const token = f.c.token;
    const user = {
      name: "alice",
      address: alice.address,
      signer: alice,
      investorRequest: { requestedType: "RETAIL" } as any,
    } as any;
    const req = await Custody.requestStatus(state, user, "RETAIL", quiet);
    expect(req.status).to.equal("Pending");
    // As option 21 binds it: ComplianceRules reads VSC's registry.
    await f.c.complianceRules.setTokenIdentityRegistry(
      await token.getAddress(),
      await f.c.identityRegistry.getAddress(),
    );
    if (!(await token.isAgent(deployer.address)))
      await token.addAgent(deployer.address);
    await token.mint(alice.address, req.lock);
    const w = await Custody.createWallet(state, user, quiet);
    expect(ethers.keccak256(await ethers.provider.getCode(w))).to.equal(
      await walletCodeHash("MultiSigWallet"),
    );
    expect(
      await f.c.complianceRules["isTrustedContract(address,address)"](
        await token.getAddress(),
        w,
      ),
    ).to.equal(true);
    const { before, after } = await Custody.lock(state, user, quiet);
    expect(after[0]).to.equal(before[0] - req.lock);
    expect(after[1]).to.equal(before[1] + req.lock);
    expect((await Custody.requestOf(state, user)).status).to.equal(
      "TokensLocked",
    );
    expect(await Custody.approve(state, user, quiet)).to.equal(1n);
    const { released } = await Custody.downgrade(state, user, quiet);
    expect(released).to.equal(req.lock);
    expect(await token.balanceOf(w)).to.equal(0n);
    expect(await token.balanceOf(alice.address)).to.equal(before[0]);
    expect(
      await f.c.investorTypeRegistry.getInvestorType(alice.address),
    ).to.equal(0n);
  });

  it("option 62 retires a keyless placeholder fee wallet (2E.1 undone)", async function () {
    const { deployer, voters } = f;
    const carol = voters[1];
    const factory = f.c.escrowWalletFactory;
    const idReg = f.c.identityRegistry;
    // The pre-4.3 interim: a keyless address onboarded as an identity.
    const placeholder = ethers.Wallet.createRandom().address;
    // Its OnchainID is managed by the keyless address itself.
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(placeholder);
    await idReg.registerIdentity(placeholder, await id.getAddress(), 840);
    await factory.registerInvestor(carol.address, placeholder);
    const count = await idReg.registeredIdentityCount();
    const real = await (await ethers.getContractFactory("MockTarget")).deploy(); // stands for the investor's MultiSigWallet (has code)
    const retired = await Custody.retirePlaceholder(
      state,
      factory,
      deployer,
      carol.address,
      await real.getAddress(),
      quiet,
    );
    expect(retired).to.equal(true);
    expect(await idReg.identity(placeholder)).to.equal(ethers.ZeroAddress);
    expect(await idReg.registeredIdentityCount()).to.equal(count - 1n);
    expect(await factory.isInvestor(carol.address)).to.equal(false);
    await factory.registerInvestor(carol.address, await real.getAddress());
    expect(
      (await factory.getInvestorProfile(carol.address)).walletAddress,
    ).to.equal(await real.getAddress());
    // A fee wallet with code is never retired.
    expect(
      await Custody.retirePlaceholder(
        state,
        factory,
        deployer,
        carol.address,
        placeholder,
        quiet,
      ),
    ).to.equal(false);
  });

  // Review M1: option 62 run before option 23 registered a keyed fee
  // wallet; replacing it with the MultiSigWallet deletes no identity.
  it("option 62 after option 23 for a real investor deletes nothing", async function () {
    const { deployer, voters } = f;
    const [bob, carol] = voters;
    const factory = f.c.escrowWalletFactory;
    const idReg = f.c.identityRegistry;
    // bob, a verified voter, was carol's fee wallet (as signer 3 or ops is).
    await factory.registerInvestor(carol.address, bob.address);
    const bobId = await idReg.identity(bob.address);
    const count = await idReg.registeredIdentityCount();
    const real = await (await ethers.getContractFactory("MockTarget")).deploy();
    expect(await Custody.isKeylessPlaceholder(state, bob.address)).to.equal(
      false,
    );
    expect(
      await Custody.retirePlaceholder(
        state,
        factory,
        deployer,
        carol.address,
        await real.getAddress(),
        quiet,
      ),
    ).to.equal(true);
    expect(await idReg.identity(bob.address)).to.equal(bobId);
    expect(await idReg.registeredIdentityCount()).to.equal(count);
    expect(await factory.isInvestor(carol.address)).to.equal(false);

    // Not a demo signer, but its OnchainID gives the deployer a MANAGEMENT
    // key: a keyed identity, also kept.
    const other = ethers.Wallet.createRandom().address;
    const id = await (
      await ethers.getContractFactory("OnchainID")
    ).deploy(deployer.address);
    await idReg.registerIdentity(other, await id.getAddress(), 840);
    expect(await Custody.isKeylessPlaceholder(state, other)).to.equal(false);
    expect(
      await Custody.isKeylessPlaceholder(
        state,
        ethers.Wallet.createRandom().address,
      ),
    ).to.equal(true);
  });
});
