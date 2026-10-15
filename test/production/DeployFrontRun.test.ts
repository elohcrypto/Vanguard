import { expect } from "chai";
import { artifacts, ethers, network } from "hardhat";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import * as h from "../helpers/deployRecordFlow";
const { deployIdentity } = require("../../demo/utils/Onboard");

/**
 * Plan v2 Task 5.7 (review M-1): deployOnchainID is permissionless and its
 * salt sits in the mempool, so anyone can mine a copy of the deploy's
 * identity call first; the deploy's own then reverts ("Salt already
 * used"), is recorded as reverted and replayed on every resume. Onboarding
 * accepts the identity the factory then holds for the wallet only when it
 * is the factory's own, owned and keyed by the wallet alone and pinned to
 * the factory's KeyManager (I-2); anything else fails as before. The probe
 * shape is the reviewer's: automine off, the attacker copies the pending
 * input at a higher gas price.
 */
describe("Production deploy: a front-run identity deploy (Task 5.7, M-1)", function () {
  const box = h.files();

  async function factoryWithKeyManager() {
    const [d] = await ethers.getSigners();
    const kmHash = ethers.keccak256(
      (await artifacts.readArtifact("KeyManager")).deployedBytecode,
    );
    const factory = await (
      await ethers.getContractFactory("OnchainIDFactory")
    ).deploy(d.address, kmHash);
    const km = await (await ethers.getContractFactory("KeyManager")).deploy();
    await (await factory.setRecoveryManager(await km.getAddress())).wait();
    return { factory, km: await km.getAddress() };
  }

  it("accepts the copy mined first, resumes twice, and gives the attacker nothing", async function () {
    const s = await ethers.getSigners();
    const [w, attacker] = [s[1].address, s[7]];
    const { factory, km } = await factoryWithKeyManager();
    const salt = ethers.id("record salt");
    const outside = network.provider.request.bind(network.provider);
    let frontRun = true;
    const flow = async () => {
      if ((await factory.getIdentityByOwner(w)) === ethers.ZeroAddress) {
        if (!frontRun) {
          await deployIdentity(factory, w, salt);
        } else {
          await network.provider.send("evm_setAutomine", [false]);
          let mine: Promise<unknown> = Promise.resolve();
          try {
            mine = deployIdentity(factory, w, salt);
            let p: any[] = [];
            for (let i = 0; i < 200 && !p.length; i++) {
              p = await network.provider.send("eth_pendingTransactions", []);
              if (!p.length) await new Promise((ok) => setTimeout(ok, 50));
            }
            expect(p, "the deploy's identity call is pending").to.have.length(
              1,
            );
            // Outside the deploy: past the record's hook, as another node's
            // sender would be.
            await outside({
              method: "eth_sendTransaction",
              params: [
                {
                  from: attacker.address,
                  to: await factory.getAddress(),
                  data: p[0].input,
                  gasPrice: ethers.toQuantity(50n * 10n ** 9n),
                  gas: ethers.toQuantity(5_000_000),
                },
              ],
            });
          } finally {
            // Both in the next blocks, the attacker's first (higher fee).
            for (let i = 0; i < 5; i++) {
              await network.provider.send("evm_mine", []);
              const left = await network.provider.send(
                "eth_pendingTransactions",
                [],
              );
              if (!left.length) break;
            }
            await network.provider.send("evm_setAutomine", [true]);
          }
          expect(await mine).to.equal(null); // the attacker's copy stands
        }
      }
      await (await s[0].sendTransaction({ to: h.AGENT })).wait();
    };
    await h.run(box.file, await h.fresh(box.file), flow);
    expect(loadRecord(box.file)!.txs.map((t) => t.status)).to.deep.equal([
      "reverted",
      "confirmed",
    ]);
    frontRun = false;
    for (let i = 0; i < 2; i++) {
      const b = await h.run(box.file, loadRecord(box.file)!, flow);
      expect([b.r.sent, b.r.reused]).to.deep.equal([0, 2]);
    }
    const id = await ethers.getContractAt(
      "OnchainID",
      await factory.getIdentityByOwner(w),
    );
    expect(await id.owner()).to.equal(w);
    expect(await id.getKeysByPurpose(1)).to.deep.equal([
      ethers.solidityPackedKeccak256(["address"], [w]),
    ]);
    const key = ethers.solidityPackedKeccak256(["address"], [attacker.address]);
    for (const purpose of [1, 2, 3]) {
      expect(await id.keyHasPurpose(key, purpose)).to.equal(false);
    }
    expect(await id.recoveryManager()).to.equal(km);
  });

  it("without a front-run deploys as before; another identity in the way still fails", async function () {
    const s = await ethers.getSigners();
    const { factory } = await factoryWithKeyManager();
    const rc = await deployIdentity(factory, s[2].address, ethers.id("a"));
    expect(rc.status).to.equal(1);
    // s[3] made its own identity with a second management key: refused.
    const extra = ethers.solidityPackedKeccak256(["address"], [s[4].address]);
    await (
      await factory
        .connect(s[3])
        .deployOnchainIDWithKey(s[3].address, extra, ethers.id("b"))
    ).wait();
    await expect(
      deployIdentity(factory, s[3].address, ethers.id("b")),
    ).to.be.rejectedWith("OnchainIDFactory: Salt already used");
  });
});
