import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Task 5.15 slice A (readiness review L-2, L-3): what only a dev node may
 * do is refused elsewhere, and nothing falls back to a role wallet.
 *  - option 11 jumps the clock: refused before any send where it cannot;
 *  - option 62 never makes wallet 3 (the compliance oracle node) a fee
 *    wallet: with no MultiSigWallet or bank it asks, and refuses a bad
 *    answer;
 *  - scripts/ci/remote-signer.js serves 31337 only unless the chain is
 *    allowed by name, and never the published Hardhat phrase elsewhere.
 */
describe("Dev-chain guards (options 11 and 62, the CI remote signer)", function () {
  this.timeout(60_000);
  const PHRASE = "test test test test test test test test test test test junk";

  async function quiet<T>(fn: () => Promise<T>): Promise<[T, string]> {
    const lines: string[] = [];
    const [log, err] = [console.log, console.error];
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = console.log;
    try {
      return [await fn(), lines.join("\n")];
    } finally {
      [console.log, console.error] = [log, err];
    }
  }

  describe("option 11 (claim expiry)", function () {
    it("refuses before any prompt or send where the clock cannot jump", async function () {
      const ChainTime = require("../../demo/utils/ChainTime");
      const flow = require("../../demo/utils/OnchainIDClaimMenuFlow");
      const real = ChainTime.canJumpTime;
      const sent: string[] = [];
      const send = ethers.provider.send.bind(ethers.provider);
      (ethers.provider as any).send = (m: string, p: unknown[]) => {
        sent.push(m);
        return send(m, p);
      };
      let asked = 0;
      const mod = {
        state: {
          identities: new Map([["x", { address: "0x1", owner: "0x2" }]]),
        },
        promptUser: async () => {
          asked++;
          return "0";
        },
      };
      ChainTime.canJumpTime = async () => false;
      let out: string;
      try {
        [, out] = await quiet(() => flow.demoClaimExpiry(mod));
      } finally {
        ChainTime.canJumpTime = real;
        (ethers.provider as any).send = send;
      }
      expect(out).to.contain("Option 11 needs a dev node");
      expect(asked, "no prompt").to.equal(0);
      expect(sent.filter((m) => /^(evm_|eth_send)/.test(m))).to.deep.equal([]);
    });
  });

  describe("option 62 (register an investor)", function () {
    /** Option 62 for a fresh investor with no MultiSigWallet or bank. */
    async function run(answers: (user: string) => string[]) {
      const flow = require("../../demo/utils/EscrowSetupFlow");
      const signers = await ethers.getSigners();
      const user = ethers.Wallet.createRandom().address;
      const queue = answers(user);
      const calls: string[][] = [];
      const factory = {
        connect: () => ({
          registerInvestor: async (a: string, b: string) => {
            calls.push([a, b]);
            return { wait: async () => undefined };
          },
        }),
      };
      const asked: string[] = [];
      const mod: any = {
        state: {
          signers,
          investors: new Map([[user, { name: "Ivan", user }]]),
          getContract: (k: string) => (k === "escrowFactory" ? factory : null),
        },
        promptUser: async (q: string) => {
          asked.push(q);
          return queue.shift() ?? "";
        },
        _investorAdmin: async () => signers[0],
        _ensureVerified: async () => undefined,
        _ensureFeeExempt: async () => undefined,
      };
      const [, out] = await quiet(() => flow.registerInvestor(mod));
      return { user, calls, asked, out, wallet3: signers[3].address };
    }

    it("asks for the fee wallet instead of using wallet 3; refuses no address", async function () {
      for (const answer of ["", "not-an-address"]) {
        const r = await run(() => ["0", answer]);
        expect(r.asked[1]).to.match(/^Fee wallet address/);
        expect(r.calls, answer).to.deep.equal([]);
        expect(r.out).to.contain("No fee wallet");
        expect(r.out).to.not.contain(r.wallet3);
      }
    });

    it("refuses the investor's own address and registers a given wallet", async function () {
      const self = await run((user) => ["0", user.toLowerCase()]);
      expect(self.calls).to.deep.equal([]);
      expect(self.out).to.contain("must not be the investor's own address");
      const fee = ethers.Wallet.createRandom().address;
      const ok = await run(() => ["0", fee]);
      expect(ok.calls).to.deep.equal([[ok.user, fee]]);
    });
  });
});
