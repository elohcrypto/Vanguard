// Review F-3, round 7 (the attacker G's round-6 surviving mutants, killed):
// each test below fails under one mutant and passes unmutated.
//   W04  isCodeOf matching by length: same-length wrong code is refused.
//   W05  maskedCodeHash zeroing a range past the end of the code: a
//        truncated runtime hashes with only the ranges it holds zeroed.
//   W07  the recovery drill's identity creation back to waitForDeployment:
//        a STOP contract stops the drill naming OnchainID.
//   G5-W05  the oracle-node read-back without `registered`: a node removed
//        before the read-back stops option 31 by name (removeOracle keeps
//        its name, description and reputation; only `registered` sees it).
//   InvestorTypeProof's probe stack through deployed(): a probe creation
//        swapped for STOP stops option 58's tier proof naming it.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { capture, ask } = require("../helpers/deployFlows");
const {
  isCodeOf,
  maskedCodeHash,
  immutableRanges,
} = require("../../demo/utils/HandoverCodeHash");
const { runRecoveryDrill } = require("../../demo/utils/KeyRecoveryDrill");
const { onboard } = require("../../demo/utils/Onboard");
const { ORACLE_NODES } = require("../../demo/utils/DeployDefaults");

/** Init code that deploys the one-byte runtime 0x00 (STOP). */
const STOP_INIT = "0x6001600c60003960016000f300";

/** `fn` with each eth_sendTransaction passed to `onSend(tx, send)` first. */
async function sending(onSend, fn) {
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  const shim = async (a) => {
    if (a.method === "eth_sendTransaction") {
      const out = await onSend(a.params[0], (t) =>
        request({ method: a.method, params: [t] }),
      );
      if (out) return out;
    }
    return request(a);
  };
  p.request = shim;
  p.send = (m, x) => shim({ method: m, params: x ?? [] });
  try {
    return await fn();
  } finally {
    [p.request, p.send] = [request, send];
  }
}

/** `fn` on the chain as it is now, reverted after. */
async function fresh(fn) {
  const id = await network.provider.request({ method: "evm_snapshot" });
  try {
    return await fn();
  } finally {
    await network.provider.request({ method: "evm_revert", params: [id] });
  }
}

/** The first creation of `artifact` sent as the STOP contract. */
async function stopFirst(artifact) {
  const code = (await artifacts.readArtifact(artifact)).bytecode.toLowerCase();
  let hits = 0;
  const edit = (tx) => {
    const data = String(tx.data ?? tx.input ?? "").toLowerCase();
    if (hits || tx.to || !data.startsWith(code)) return null;
    hits++;
    const t = { ...tx, data: STOP_INIT };
    delete t.input;
    return t;
  };
  return { edit, hits: () => hits };
}

async function deployerOver() {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  return {
    state,
    deployer: new ContractDeployer(state, logger),
    inv: new InvestorTypeModule(state, logger, ask),
  };
}

const notCode = (name) =>
  new RegExp(`${name} at 0x[0-9a-fA-F]{40} has code that is not ${name}'s`);

describe("F-3 round 7: pins for the surviving demo mutants", function () {
  this.timeout(1800000);

  it("W04: same-length wrong code is not the artifact's (no immutables)", async function () {
    const name = "PrivacyManager";
    expect(await immutableRanges(name)).to.deep.equal([]);
    const { deployedBytecode } = await artifacts.readArtifact(name);
    const b = ethers.getBytes(deployedBytecode);
    b[b.length >> 1] ^= 0x01;
    const wrong = ethers.hexlify(b);
    expect(wrong.length).to.equal(deployedBytecode.length);
    expect(await isCodeOf(deployedBytecode, name)).to.equal(true);
    expect(await isCodeOf(wrong, name)).to.equal(false);
  });

  it("W05: a truncated runtime hashes with only the immutable ranges it holds zeroed", async function () {
    const name = "InvestorRequestManager";
    const ranges = await immutableRanges(name);
    expect(ranges.length).to.be.greaterThan(0);
    // The runtime as deployed: each immutable range filled (non-zero).
    const full = ethers.getBytes(
      (await artifacts.readArtifact(name)).deployedBytecode,
    );
    for (const r of ranges) full.fill(0x11, r.start, r.start + r.length);
    const last = ranges.reduce((a, r) =>
      r.start + r.length > a.start + a.length ? r : a,
    );
    // Cut inside the last range: its head is in the code, its end is not.
    const cut = full.slice(0, last.start + last.length - 1);
    const want = cut.slice();
    for (const r of ranges) {
      if (r.start + r.length <= want.length)
        want.fill(0, r.start, r.start + r.length);
    }
    expect(await maskedCodeHash(null, name, ethers.hexlify(cut))).to.equal(
      ethers.keccak256(want),
    );
    // And the whole runtime masks to the artifact's hash.
    expect(await maskedCodeHash(null, name, ethers.hexlify(full))).to.equal(
      ethers.keccak256((await artifacts.readArtifact(name)).deployedBytecode),
    );
  });

  it("W07: the drill identity's creation swapped for STOP stops the drill naming OnchainID", async function () {
    await fresh(async () => {
      const s = await ethers.getSigners();
      const km = await (await ethers.getContractFactory("KeyManager")).deploy();
      await km.waitForDeployment();
      const swap = await stopFirst("OnchainID");
      let err = null;
      await sending(
        async (tx, send) => {
          const t = swap.edit(tx);
          return t ? send(t) : null;
        },
        () =>
          capture(() =>
            runRecoveryDrill(
              { signers: s, getContract: () => undefined },
              {
                km,
                owner: s[1],
                recovered: s[2],
                agents: [s[3], s[4]],
                back: "option 12",
                run: {},
              },
            ).catch((e) => {
              err = e;
            }),
          ),
      );
      expect(swap.hits()).to.equal(1);
      expect(err?.message).to.match(notCode("OnchainID"));
    });
  });

  it("G5-W05: a node removed before option 31's read-back stops it by name", async function () {
    await fresh(async () => {
      const m = await deployerOver();
      await capture(async () => {
        await m.deployer.deployAllContracts();
        await m.deployer.deployComplianceRules();
        await m.deployer.deployDigitalTokenSystem();
      });
      const om = new ethers.Interface([
        "function registerOracle(address,string,string,uint256)",
        "function removeOracle(address,string)",
      ]);
      const reg = om.getFunction("registerOracle").selector;
      const lastNode = m.state.signers[ORACLE_NODES.at(-1)[1]].address;
      const firstNode = m.state.signers[ORACLE_NODES[0][1]].address;
      let removed = 0;
      let lines = [];
      await sending(
        async (tx, send) => {
          const data = String(tx.data ?? tx.input ?? "").toLowerCase();
          if (!tx.to || !data.startsWith(reg)) return null;
          const [who] = om.decodeFunctionData("registerOracle", data);
          if (who.toLowerCase() !== lastNode.toLowerCase()) return null;
          const h = await send(tx);
          // The owner removes the first node before the read-back.
          await send({
            from: tx.from,
            to: tx.to,
            data: om.encodeFunctionData("removeOracle", [firstNode, "pin"]),
          });
          removed++;
          return h;
        },
        async () => {
          [, lines] = await capture(() =>
            m.deployer
              .deployOracleSystem()
              .catch((e) => console.log(`THROWN: ${e.message}`)),
          );
        },
      );
      const text = lines.join("\n");
      expect(removed).to.equal(1);
      expect(text).to.contain(
        "missing wiring: oracle nodes registered on OracleManager",
      );
      expect(text).to.not.contain(
        "Oracle Management System deployed successfully!",
      );
      expect(m.state.getContract("oracleManager")).to.equal(undefined);
    });
  });

  it("InvestorTypeProof: a probe creation swapped for STOP stops option 58's tier proof naming it", async function () {
    await fresh(async () => {
      const m = await deployerOver();
      await capture(async () => {
        await m.deployer.deployAllContracts();
        await m.deployer.deployComplianceRules();
        await m.deployer.deployDigitalTokenSystem();
        await m.deployer.deployOracleSystem();
        for (const i of [2, 3])
          await onboard(m.state, m.state.signers[i].address);
      });
      const swap = await stopFirst("ComplianceRules");
      let lines = [];
      await sending(
        async (tx, send) => {
          const t = swap.edit(tx);
          return t ? send(t) : null;
        },
        async () => {
          [, lines] = await capture(() => m.inv.testTransferCooldowns());
        },
      );
      const text = lines.join("\n");
      expect(swap.hits()).to.equal(1);
      expect(text).to.match(
        /tier proof stopped: ComplianceRules at 0x[0-9a-fA-F]{40} has code that is not ComplianceRules's/,
      );
    });
  });
});
