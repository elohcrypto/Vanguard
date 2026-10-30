/**
 * U2 round 13 (item B, R13-C3; lane G R1, lead M1): the window scan of
 * deployRecordStrays.ts, moved here by the 500-line rule. One pass over
 * blocks `block`..`block` + 5000 (at most the head) per resume, the first
 * transaction of `from` at each nonce of `want`, by nonce; it stops once
 * every nonce is found.
 */
import { ethers } from "hardhat";

export async function scanWindow(
  raw: (method: string, params?: unknown[]) => Promise<any>,
  from: string,
  block: number,
  want: number[],
  head: number,
): Promise<Map<number, any>> {
  const seen = new Map<number, any>();
  const me = from.toLowerCase();
  const end = Math.min(head, block + 5000);
  for (let b = block; b <= end && seen.size < want.length; b++) {
    const blk = await raw("eth_getBlockByNumber", [ethers.toQuantity(b), true]);
    for (const t of blk?.transactions ?? []) {
      const n = Number(t.nonce);
      if (String(t.from).toLowerCase() === me && want.includes(n) && !seen.has(n))
        seen.set(n, t);
    }
  }
  return seen;
}
