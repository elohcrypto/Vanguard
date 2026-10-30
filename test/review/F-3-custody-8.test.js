// Review F-3, round 8 (item C2, the custody manager's other deploy sites):
// deployCustody reads the manager's constructor links right after the
// deploy, whichever path deploys it. Each address argument (decoded with
// the artifact's ABI) swapped for another contract's address stops by
// name, and demo state holds no contract at the swapped address:
//   (a) option 21 run after option 51 (21 deploys the manager then);
//   (b) the first use (deployCustody(state), as options 23 and 62 call it);
// and (c) a manager in state with another identity registry is not reused.
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const DemoState = require("../../demo/core/DemoState");
const ContractDeployer = require("../../demo/core/ContractDeployer");
const InvestorTypeModule = require("../../demo/modules/InvestorTypeModule");
const { EnhancedLogger } = require("../../demo/logging");
const { deployCustody } = require("../../demo/utils/CustodyFlow");
const { capture, ask } = require("../helpers/deployFlows");

/** `fn` with each eth_sendTransaction passed to `onSend(tx, send)` first. */
async function sending(onSend, fn) {
  const p = network.provider;
  const [request, send] = [p.request.bind(p), p.send.bind(p)];
  const shim = async (a) => {
    if (a.method === "eth_sendTransaction") {
      const tx = a.params[0];
      const out = await onSend(tx, (t) =>
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

/** Demo state after `steps` (of options 1, 13, 21, 51), in that order. */
async function after(steps) {
  const state = new DemoState();
  state.signers = await ethers.getSigners();
  const logger = new EnhancedLogger();
  const deployer = new ContractDeployer(state, logger);
  const inv = new InvestorTypeModule(state, logger, ask);
  const run = {
    1: () => deployer.deployAllContracts(),
    13: () => deployer.deployComplianceRules(),
    21: () => deployer.deployDigitalTokenSystem(),
    51: () => inv.deployInvestorTypeSystem(),
  };
  for (const s of steps) await capture(() => run[s]());
  return { state, run };
}

/** Demo state's keys holding `at`. */
const holding = (state, at) =>
  Object.entries(state.contracts)
    .filter(
      ([, c]) => at && String(c?.target).toLowerCase() === at.toLowerCase(),
    )
    .map(([k]) => k);

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** A stop that names its cause: a link, or a revert's reason or error. */
const NAMED =
  /^missing wiring: |reverted with (reason string|custom error|panic code) '/;

const IRM = artifacts.readArtifactSync("InvestorRequestManager");
const CODE = IRM.bytecode.toLowerCase();
const TYPES = new ethers.Interface(IRM.abi).deploy.inputs;
const coder = ethers.AbiCoder.defaultAbiCoder();

/**
 * `fn` with the manager's creation sent with its address argument `i`
 * swapped for `decoy`; returns { hits, at (the swapped creation's
 * address), out (fn's result) }.
 */
async function swapping(i, decoy, fn) {
  const r = { hits: 0, at: null };
  r.out = await sending(async (tx, send) => {
    const data = String(tx.data ?? tx.input ?? "").toLowerCase();
    if (tx.to || !data.startsWith(CODE)) return null;
    r.hits++;
    const v = coder.decode(TYPES, "0x" + data.slice(CODE.length)).toArray();
    r.was = v[i];
    v[i] = decoy;
    const t = { ...tx, data: CODE + coder.encode(TYPES, v).slice(2) };
    delete t.input;
    const h = await send(t);
    r.at = (await ethers.provider.getTransactionReceipt(h)).contractAddress;
    return h;
  }, fn);
  return r;
}

describe("F-3 round 8: every path that deploys the custody manager reads its arguments back", function () {
  this.timeout(600000);
  // The manager's address arguments, from its ABI (not a hand list).
  const words = TYPES.map((t, i) => [t.name, i]).filter(
    ([, i]) => TYPES[i].type === "address",
  );

  /** Each word swapped in turn under `go(i, decoy)`; the rows that fail. */
  async function each(go) {
    const bad = [];
    for (const [name, i] of words) {
      const r = await fresh(() => go(i));
      if (r.hits !== 1 || same(r.was, r.decoy))
        bad.push(`${name}: not swapped`);
      else if (!NAMED.test(r.stop)) bad.push(`${name}: ${r.stop || "no stop"}`);
      else if (r.banner) bad.push(`${name}: banner`);
      else if (r.held.length) bad.push(`${name}: state ${r.held}`);
    }
    return bad;
  }

  it("(a) option 21 after 51 with each of the manager's address arguments swapped for another contract stops option 21 by name; state holds no manager there", async function () {
    const bad = await each(async (i) => {
      const { state, run } = await after(["1", "13", "51"]);
      const decoy = state.getContract("onchainIDFactory").target;
      const s = await swapping(i, decoy, () =>
        capture(() =>
          run[21]().catch((e) => console.log(`THROWN: ${e.message}`)),
        ),
      );
      const text = s.out[1].join("\n");
      return {
        ...s,
        decoy,
        stop: (text.match(/^THROWN: (.*)$/m) || [])[1],
        banner: text.includes("ERC-3643 DIGITAL TOKEN SYSTEM DEPLOYED!"),
        held: holding(state, s.at),
      };
    });
    expect(words.length).to.be.greaterThan(0);
    expect(bad).to.deep.equal([]);
  });

  it("(b) the first use, deployCustody(state), with each of the manager's address arguments swapped for another contract is refused by name; state holds no manager", async function () {
    const bad = await each(async (i) => {
      const { state } = await after(["1", "13", "21", "51"]);
      state.setContract("investorRequestManager", undefined); // first use
      const decoy = state.getContract("onchainIDFactory").target;
      const s = await swapping(i, decoy, () =>
        deployCustody(state, () => {}).then(
          () => "",
          (e) => e.message,
        ),
      );
      const held = holding(state, s.at);
      if (state.getContract("investorRequestManager")) held.push("(any)");
      return { ...s, decoy, stop: s.out, banner: false, held };
    });
    expect(bad).to.deep.equal([]);
  });

  it("(c) a manager in state with another identity registry is redeployed, not reused", async function () {
    await fresh(async () => {
      const { state } = await after(["1", "13", "21", "51"]);
      const ops = state.signers[10].address;
      const [vsc, types, ir, other] = [
        "digitalToken",
        "investorTypeRegistry",
        "identityRegistry",
        "onchainIDFactory",
      ].map((k) => state.getContract(k).target);
      const stale = await (
        await ethers.getContractFactory("InvestorRequestManager")
      ).deploy(ops, vsc, types, other);
      await stale.waitForDeployment();
      state.setContract("investorRequestManager", stale);

      const m = await deployCustody(state, () => {});
      expect(m.target, "a new manager").to.not.equal(stale.target);
      expect(await m.identityRegistry()).to.equal(ir);
      expect(state.getContract("investorRequestManager")).to.equal(m);
    });
  });
});
