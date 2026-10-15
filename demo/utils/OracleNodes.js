/**
 * @fileoverview Which OracleManager nodes are registered now, and which of
 * them the demo can make answer (plan v2 Task 5.12, D50). Read from chain
 * (getRegisteredOracles) every time, so after a rotation by vote the
 * rounds of options 33a, 34a, 35a and 37 are answered by the nodes on
 * chain, never by option 31's wallets 1-3 by assumption. A node the demo
 * cannot make answer is named, never skipped silently.
 */

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * [{ address, signer, active }] for every registered node, in chain
 * order; `signer` the demo wallet holding its key or null, `active` its
 * isActiveOracle (a paused node cannot raise or answer).
 */
async function registeredNodes(state) {
  const om = state.getContract("oracleManager");
  const out = [];
  for (const address of await om.getRegisteredOracles()) {
    out.push({
      address,
      signer: state.signers.find((s) => same(s.address, address)) || null,
      active: await om.isActiveOracle(address),
    });
  }
  return out;
}

/**
 * The demo signers of the registered, active nodes, in chain order: the
 * nodes that can raise and answer a query now. A node with no demo key
 * or a paused one gets a line saying it cannot answer.
 */
async function nodeSigners(state, log = console.log) {
  const out = [];
  for (const n of await registeredNodes(state)) {
    if (!n.signer) {
      log(
        `   ⚠️  node ${n.address} (registered on chain): no demo key: cannot answer`,
      );
    } else if (!n.active) {
      log(`   ⏸️  node ${n.address} paused: cannot answer`);
    } else out.push(n.signer);
  }
  return out;
}

module.exports = { registeredNodes, nodeSigners };
