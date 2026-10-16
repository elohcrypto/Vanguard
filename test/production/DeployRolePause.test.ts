import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import { getAddress } from "ethers";
import { handoverFixture } from "../helpers/governanceFixture";
import * as h from "../helpers/deployRecordFlow";
import { Recorder } from "../../scripts/production/deployRecord";
import { loadRecord } from "../../scripts/production/deployRecordFile";
import { resolveInputs } from "../../scripts/production/deployConfig";
import { handoverConfig } from "../../scripts/production/deployHandover";
import {
  rolePause,
  vetExternalRoles,
} from "../../scripts/production/DeployProduction";

const Custody = require("../../demo/utils/CustodyFlow");
const { batchProblems } = require("../../demo/utils/RoleCalls");

const ATTESTOR = { Ax: "1", Ay: "2" };
const accounts = Array.from(
  { length: 12 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
);

/**
 * Plan v2 Task 5.13 (Q11 = B): the production deploy with ops as a
 * multisig. Its config takes an external role; the custody step sends the
 * nomination, exports ops's acceptOwnership and halts the record; a re-run
 * replays it and checks the effect: pause again, continue, or refuse.
 */
describe("Production deploy with a multisig ops (Task 5.13)", function () {
  it("an external role need not be a signer account; others still must", function () {
    delete process.env.OPS_IDENTITY;
    const plain = resolveInputs({ attestor: ATTESTOR }, 31337, accounts);
    expect(plain.external).to.deep.equal([]);
    // A signer-held deploy's digest is the one records made before 5.13 hold.
    expect(plain.digest).to.equal(
      "08ec8065f5574a1bcd16f4fc7bf4a3dee699366d59632ea142b9a1cc77a59f09",
    );
    const ms = getAddress("0x00000000000000000000000000000000000000aa");
    const coded = resolveInputs(
      { attestor: ATTESTOR, ops: ms },
      31337,
      accounts,
      new Set([ms.toLowerCase()]),
    );
    expect(coded.external).to.deep.equal(["ops"]);
    expect(coded.digest).to.not.equal(plain.digest);
    const marked = resolveInputs(
      { attestor: ATTESTOR, issuerAdmin: ms, externalRoles: ["issuerAdmin"] },
      31337,
      accounts,
    );
    expect(marked.external).to.deep.equal(["issuerAdmin"]);
    expect(() =>
      resolveInputs({ attestor: ATTESTOR, ops: ms }, 31337, accounts),
    ).to.throw(`ops ${ms} is not an account of the external signer`);
    expect(() =>
      resolveInputs(
        { attestor: ATTESTOR, proposer: ms, externalRoles: ["proposer"] },
        31337,
        accounts,
      ),
    ).to.throw(
      '"externalRoles" must list roles among ops, issuerAdmin, guardian',
    );
    // handover.json names an external role by address, others by index.
    const cfg = handoverConfig(coded, {}, accounts, 0, 100);
    expect([cfg.ops, cfg.guardian, cfg.issuerAdmin]).to.deep.equal([ms, 11, 9]);
  });

  it("a defaulted role whose account has code is refused (LOW-2)", function () {
    // Its default is a wallet index of the signer: a contract or an
    // EIP-7702 delegated account is written as an address instead.
    expect(() =>
      resolveInputs(
        { attestor: ATTESTOR },
        31337,
        accounts,
        new Set([accounts[10].toLowerCase()]),
      ),
    ).to.throw(
      /"ops" defaults to the signer's account 10, whose address has code .*write it as an address/,
    );
  });

  describe("custody pause and resume on the record", function () {
    const box = h.files();
    let f: Awaited<ReturnType<typeof handoverFixture>>;
    let ms: any;
    let state: any;
    let out: string[];
    const owners = async () => (await ethers.getSigners()).slice(12, 14);

    beforeEach(async function () {
      f = await handoverFixture();
      const [a, b] = await owners();
      ms = await (
        await ethers.getContractFactory("TestMultisig")
      ).deploy([a.address, b.address], 2);
      const byName: Record<string, any> = {
        digitalToken: f.c.token,
        complianceRules: f.c.complianceRules,
        identityRegistry: f.c.identityRegistry,
        investorTypeRegistry: f.c.investorTypeRegistry,
        vanguardGovernance: f.c.governance,
      };
      const signers: any[] = await ethers.getSigners();
      signers[10] = { address: await ms.getAddress() }; // ops: the multisig
      state = {
        signers,
        getContract: (n: string) => byName[n],
        setContract: (n: string, c: any) => void (byName[n] = c),
      };
      out = [];
    });

    /** deployCustody under a Recorder, as DeployProduction.deployOn runs. */
    async function deploy(rec: any, swallow = false) {
      const r = new Recorder(box.file, rec, 1, () => {});
      await r.install();
      const inputs: any = {
        external: ["ops"],
        ops: await ms.getAddress(),
        deployer: f.deployer.address,
      };
      const roles = rolePause(inputs, box.file, r);
      state.production = { roles };
      state.setContract("investorRequestManager", undefined);
      const log = (m: string) => void out.push(m);
      const quiet = console.log;
      console.log = log;
      try {
        await Custody.deployCustody(state, log).catch(async (e: Error) => {
          if (!swallow) throw e;
          // A demo catch that swallows the pause: the next send still fails.
          await (await f.c.token.addAgent(f.stranger.address)).wait();
        });
        await r.finish();
        return r;
      } catch (e) {
        if (!roles.stop) throw e;
        await r.confirmLast();
        throw roles.stop;
      } finally {
        console.log = quiet;
        r.remove();
      }
    }
    const batchFile = () =>
      box.file.replace(/\.json$/, ".ops-transactions.json");
    async function execute(calls: any[]) {
      const c = calls.map((x) => ({ to: x.to, value: x.value, data: x.data }));
      const hash = await ms.hashOf(c);
      const [a, b] = await owners();
      for (const o of [a, b]) await (await ms.connect(o).approve(hash)).wait();
      await (await ms.connect(a).execute(c)).wait();
    }
    const officer = async (m: string) =>
      f.c.investorTypeRegistry.isComplianceOfficer(m);

    it("refuses a multisig ops the deployer owns; warns on an unreadable one (LOW-5)", async function () {
      const lines: string[] = [];
      const log = (m: string) => void lines.push(m);
      const at: any = { external: ["ops"], deployer: f.deployer.address };
      await vetExternalRoles({ ...at, ops: await ms.getAddress() }, log);
      expect(lines.pop()).to.include(
        "is a 2-of-2 multisig; the deployer is no listed owner",
      );
      const t = await (await ethers.getContractFactory("MockTarget")).deploy();
      await vetExternalRoles({ ...at, ops: await t.getAddress() }, log);
      expect(lines.pop()).to.include(
        `⚠️  ops ${await t.getAddress()} has code but no readable getOwners()/getThreshold()`,
      );
      const [a] = await owners();
      const mine = await (
        await ethers.getContractFactory("TestMultisig")
      ).deploy([a.address, f.deployer.address], 2);
      await expect(
        vetExternalRoles({ ...at, ops: await mine.getAddress() }, log),
      ).to.be.rejectedWith(
        `lists the deployer ${f.deployer.address} as an owner`,
      );
    });

    it("refuses a send from an external role the signer holds a key for (LOW-1)", async function () {
      const ops = (await ethers.getSigners())[10];
      const r = new Recorder(box.file, await h.fresh(box.file), 1, () => {});
      r.refuseFrom({ ops: ops.address });
      await r.install();
      try {
        const n = await ethers.provider.getTransactionCount(ops.address);
        await expect(
          ops.sendTransaction({ to: ops.address }),
        ).to.be.rejectedWith(`ops ${ops.address} is external`);
        expect(await ethers.provider.getTransactionCount(ops.address)).to.equal(
          n,
        );
        expect(loadRecord(box.file)!.txs).to.have.length(0);
      } finally {
        r.remove();
      }
    });

    it("pauses at the acceptance, resumes once executed, replays across it", async function () {
      const rec = await h.fresh(box.file);
      const e = await deploy(rec).catch((x) => x);
      expect(e.name).to.equal("RoleCallsPending");
      expect(e.lines.at(-1)).to.equal(
        `⏸️  awaiting 1 ops transaction: ${batchFile()}`,
      );
      const batch = JSON.parse(fs.readFileSync(batchFile(), "utf8"));
      expect(batchProblems(batch)).to.deep.equal([]);
      expect(batch.meta.description).to.include(
        "[deploy.custody.accept] InvestorRequestManager",
      );
      const paused = loadRecord(box.file)!;
      const m = paused.txs.find((t) => t.contract)!.contract!;
      expect(paused.txs[paused.txs.length - 1].status).to.equal("confirmed");
      expect(paused.txs.every((t) => t.from === f.deployer.address)).to.equal(
        true,
      );
      const im = await ethers.getContractAt("InvestorRequestManager", m);
      expect(await im.pendingOwner()).to.equal(await ms.getAddress());
      expect(await officer(m)).to.equal(false); // no power before ops owns it
      const n = await h.nonce();
      expect(n).to.equal(paused.txs[0].nonce + paused.txs.length);
      // A re-run before execution: paused again, nothing sent.
      const again = await deploy(loadRecord(box.file)!).catch((x) => x);
      expect(again.name).to.equal("RoleCallsPending");
      expect(out.join("\n")).to.include(
        "❌ not executed: [deploy.custody.accept]",
      );
      expect(await h.nonce()).to.equal(n);
      // The owners execute; the resume sends the rest.
      await execute(batch.transactions);
      const r = await deploy(loadRecord(box.file)!);
      expect(r.reused).to.equal(paused.txs.length);
      expect(r.sent).to.be.greaterThan(0);
      expect(await officer(m)).to.equal(true);
      expect(await im.owner()).to.equal(await ms.getAddress());
      const done = loadRecord(box.file)!;
      expect(await h.nonce()).to.equal(done.txs[0].nonce + done.txs.length);
      // The complete record replays across the pause, sending nothing.
      const replay = await deploy(loadRecord(box.file)!);
      expect([replay.sent, replay.reused]).to.deep.equal([0, done.txs.length]);
    });

    it("sends nothing after the pause even when a flow swallows it", async function () {
      const rec = await h.fresh(box.file);
      const e = await deploy(rec, true).catch((x) => x);
      expect(e.name).to.equal("RoleCallsPending");
      expect(await f.c.token.isAgent(f.stranger.address)).to.equal(false);
      const recorded = loadRecord(box.file)!.txs.length;
      expect(await h.nonce()).to.equal(
        loadRecord(box.file)!.txs[0].nonce + recorded,
      );
    });

    it("refuses another effect: ops accepted, then nominated someone else", async function () {
      await deploy(await h.fresh(box.file)).catch(() => {});
      const batch = JSON.parse(fs.readFileSync(batchFile(), "utf8"));
      const m = batch.transactions[0].to;
      const im = await ethers.getContractAt("InvestorRequestManager", m);
      const moveOn = im.interface.encodeFunctionData("transferOwnership", [
        f.stranger.address,
      ]);
      await execute([
        ...batch.transactions,
        { to: m, value: "0", data: moveOn },
      ]);
      const n = await h.nonce();
      await expect(deploy(loadRecord(box.file)!)).to.be.rejectedWith(
        /another effect than exported[\s\S]*deploy\.custody\.accept\][^\n]*ownership is moving on/,
      );
      expect(await h.nonce()).to.equal(n);
      expect(await officer(m)).to.equal(false);
    });
  });
});
