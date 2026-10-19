/**
 * Task 5.17 slice C: what every production CLI that sends does first.
 *
 *  - awaitOwnSenders (deep review M-3): every key the run may send from
 *    (the deployer, the roles this signer holds, the proposer and the
 *    voters) has no transaction pending, so a re-run never reads the chain
 *    beside the killed run's in-flight one (demo/utils/PendingNonces.js;
 *    openAll and settleAll wait again before each batch).
 */
const { awaitSettledNonces } = require("../../demo/utils/PendingNonces");

/** Signers among the handoverArgs roles (an external role is skipped). */
function ownSenders(args: any): any[] {
  const roles = [args.ops, args.guardian, args.issuerAdmin].filter(
    (r) => r && !r.external,
  );
  return [args.deployer, ...roles, ...(args.voterWallets || [])];
}

/** Wait until none of the run's own senders has a transaction pending. */
export async function awaitOwnSenders(args: any, what: string): Promise<void> {
  await awaitSettledNonces(ownSenders(args), what);
}
