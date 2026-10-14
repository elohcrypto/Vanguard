/**
 * @fileoverview R-56-5 (plan v2 Task 5.6b): after the ceremony the
 * deployer key (wallet 0) sends nothing. One check, `postCeremony`
 * (governance owns VSC, TokenParameters' bound target), used by every
 * demo picker (VoterPicker.verifiedHumans, GovernedCalls.pickProposer,
 * ProposalExecutor.executorFor) to leave wallet 0 out, and by
 * `guardDeployerKey`, which the demo installs on the provider at start:
 * any transaction from wallet 0 after the ceremony is refused there
 * (DeployerKeyAfterCeremony), whichever flow tries it. During the
 * ceremony's voting window the deployer still votes (R-417-8): VSC is
 * the first contract governance accepts, and from then on the pickers
 * choose other wallets.
 */

const { ethers, network } = require("hardhat");

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const OWNER_ABI = ["function owner() view returns (address)"];

/** True once governance owns VSC. */
async function postCeremony(gov) {
  const vsc = await gov.boundTarget(3).catch(() => ethers.ZeroAddress);
  if (same(vsc, ethers.ZeroAddress)) return false;
  const t = await ethers.getContractAt(OWNER_ABI, vsc);
  return same(
    await t.owner().catch(() => ethers.ZeroAddress),
    await gov.getAddress(),
  );
}

/** postCeremony for the demo state (false before governance exists). */
async function postCeremonyOf(state) {
  const gov = state.getContract("vanguardGovernance");
  return Boolean(gov) && (await postCeremony(gov));
}

/** The refusal guardDeployerKey throws. */
function deployerKeyRefusal(method) {
  return Object.assign(
    new Error(
      `R-56-5: wallet 0 (the deployer) sends nothing after the ceremony (${method} refused); use another wallet`,
    ),
    { name: "DeployerKeyAfterCeremony" },
  );
}

/**
 * Wrap `provider` (request and send) so a transaction from wallet 0 is
 * refused once postCeremonyOf(state). Returns the provider.
 */
function guardDeployerKey(state, provider = network.provider) {
  const sends = new Set(["eth_sendTransaction", "eth_signTransaction"]);
  const check = async (method, params) => {
    if (!sends.has(method)) return;
    const d = state.signers && state.signers[0];
    const from = params && params[0] && params[0].from;
    if (d && from && same(from, d.address) && (await postCeremonyOf(state)))
      throw deployerKeyRefusal(method);
  };
  const request = provider.request.bind(provider);
  provider.request = async (args) => {
    await check(args.method, args.params);
    return request(args);
  };
  if (typeof provider.send === "function") {
    const send = provider.send.bind(provider);
    provider.send = async (method, params) => {
      await check(method, params);
      return send(method, params);
    };
  }
  return provider;
}

module.exports = { postCeremony, postCeremonyOf, guardDeployerKey };
