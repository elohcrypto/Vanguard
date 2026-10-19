/**
 * Task 5.17 slice C: what every production CLI that sends does first.
 *
 *  - awaitOwnSenders (deep review M-3): every key the run may send from
 *    (the deployer, the roles this signer holds, the proposer and the
 *    voters) has no transaction pending, so a re-run never reads the chain
 *    beside the killed run's in-flight one (demo/utils/PendingNonces.js;
 *    openAll and settleAll wait again before each batch).
 *  - guardDeployer (R-56-5, as demo/index.js): once governance owns VSC,
 *    any transaction from wallet 0 is refused at the provider
 *    (demo/utils/PostCeremony.js guardDeployerKey). Installed by the CLIs'
 *    main() only, never by a library call, so tests in one process do not
 *    stack it.
 */
import { network } from "hardhat";

const { awaitSettledNonces } = require("../../demo/utils/PendingNonces");
const { guardDeployerKey } = require("../../demo/utils/PostCeremony");

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

/** Refuse wallet 0's transactions once governance owns VSC (R-56-5). */
export function guardDeployer(deployer: any, governance: any): void {
  guardDeployerKey(
    {
      signers: [deployer],
      getContract: (k: string) =>
        k === "vanguardGovernance" ? governance : undefined,
    },
    network.provider,
  );
}
