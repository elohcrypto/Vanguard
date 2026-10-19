import { expect } from "chai";
import { ethers } from "ethers";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fakeUpstream, Live, runSigner } from "../helpers/signerProcess";
const { describeUnlessCoverage } = require("../helpers/zkProofs");

/**
 * Task 5.17 slice B (deep review M-2), end to end: scripts/production/
 * signer.js orders its keystores by file name, so a keystore added between
 * phases (claim-kyc.json sorts before deployer.json) shifts every wallet
 * index. With handover.json's "accounts" pins, the ceremony's accept phase
 * and each post-ceremony CLI (postCeremonyVotes, claimSigners,
 * onboardVoters) refuse that signer before any send, naming the index and
 * both addresses; the unshifted directory passes the check.
 *
 * Not under coverage: its child `hardhat run` processes compile the real
 * build over the instrumented artifacts (as HandoverCliNode).
 */
describeUnlessCoverage(
  "Wallet pins through the signer and the CLIs (M-2)",
  "its child `hardhat run` processes recompile the real build over the instrumented artifacts",
  function (this: Mocha.Suite) {
    this.timeout(300_000);
    const PASS = "a long enough test password";
    const NAMES = [
      "b-deployer",
      "c-ops",
      "d-guardian",
      "e-admin",
      "f-proposer",
      "g-voter",
      "h-voter",
    ];
    const keys = NAMES.map(() => ethers.Wallet.createRandom());
    let dir: string;

    const keystore = async (name: string, w: ethers.HDNodeWallet) =>
      fs.writeFileSync(
        path.join(dir, "keys", `${name}.json`),
        await ethers.encryptKeystoreJson(
          { address: w.address, privateKey: w.privateKey },
          PASS,
          { scrypt: { N: 1 << 10 } },
        ),
        { mode: 0o600 },
      );

    /** `hardhat run script --network remote` against `live`; code and output. */
    const cli = (live: Live, script: string, env: Record<string, string>) =>
      new Promise<{ code: number | null; out: string }>((ok) => {
        const p = spawn(
          "npx",
          ["hardhat", "run", script, "--network", "remote"],
          {
            env: {
              ...process.env,
              SIGNER_RPC_URL: live.url,
              SIGNER_TOKEN_FILE: path.join(dir, "token"),
              HANDOVER_CONFIG: path.join(dir, "handover.json"),
              DEPLOY_RECORD: path.join(dir, "31337.json"),
              ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        p.on("exit", (code) => ok({ code, out }));
      });

    before(async function () {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-cli-"));
      fs.mkdirSync(path.join(dir, "keys"));
      for (const [i, n] of NAMES.entries()) await keystore(n, keys[i]);
      fs.writeFileSync(path.join(dir, "pass"), PASS, { mode: 0o600 });
      // Written from the directory as it was: index i is NAMES[i]'s key.
      const accounts = Object.fromEntries(
        keys.map((k, i) => [String(i), k.address]),
      );
      fs.writeFileSync(
        path.join(dir, "handover.json"),
        JSON.stringify({
          governance: keys[0].address,
          ops: 1,
          guardian: 2,
          issuerAdmin: 3,
          proposer: 4,
          voters: [5, 6],
          accounts,
        }),
      );
      fs.writeFileSync(
        path.join(dir, "handover.json.snapshot.json"),
        JSON.stringify({ chainId: 31337 }),
      );
      fs.writeFileSync(
        path.join(dir, "31337.json"),
        JSON.stringify({
          version: 1,
          chainId: 31337,
          deployer: keys[0].address,
          txs: [],
          contracts: {},
          complete: true,
        }),
      );
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    /** The signer on `dir`/keys over a fake 31337 upstream, `use` while it runs. */
    async function withSigner(use: (live: Live) => Promise<void>) {
      const up = await fakeUpstream(31337);
      try {
        const r = await runSigner(
          "scripts/production/signer.js",
          {
            SIGNER_UPSTREAM: up.url,
            SIGNER_KEYSTORE_DIR: path.join(dir, "keys"),
            SIGNER_PASSWORD_FILE: path.join(dir, "pass"),
            SIGNER_TOKEN_FILE: path.join(dir, "token"),
            SIGNER_TEST: "1",
          },
          use,
        );
        expect(r.code, r.out).to.equal(0);
      } finally {
        up.server.close();
      }
      expect(up.raws, "nothing was sent").to.deep.equal([]);
    }

    it("the unshifted directory passes the pin check (the accept phase fails later, on the fake chain)", async function () {
      await withSigner(async (live) => {
        const r = await cli(live, "scripts/handover.ts", {
          HANDOVER_PHASE: "accept",
        });
        expect(r.code).to.equal(1);
        expect(r.out).to.contain("❌ Handover failed");
        expect(r.out).to.not.contain('"accounts" pins');
      });
    });

    it("a keystore sorting first shifts every index: the accept phase and each CLI refuse before any send", async function () {
      const extra = ethers.Wallet.createRandom();
      await keystore("a-claim-kyc", extra);
      const refusal = `wallet 0 (deployer) is ${extra.address} but "accounts" pins ${keys[0].address}: the signer's keystores changed`;
      await withSigner(async (live) => {
        for (const [script, env, head] of [
          [
            "scripts/handover.ts",
            {
              HANDOVER_PHASE: "accept",
              HANDOVER_SNAPSHOT_SHA256: "0".repeat(64),
            },
            "❌ Handover failed",
          ],
          [
            "scripts/production/postCeremonyVotes.ts",
            {},
            "❌ Post-ceremony votes failed",
          ],
          [
            "scripts/production/claimSigners.ts",
            { CLAIM_SIGNERS: `kyc:${extra.address}` },
            "❌ Claim signers failed",
          ],
          ["scripts/production/onboardVoters.ts", {}, "❌"],
        ] as const) {
          const r = await cli(live, script, env);
          expect(r.code, `${script}: ${r.out}`).to.equal(1);
          expect(r.out, script).to.contain(head);
          expect(r.out, script).to.contain(refusal);
        }
      });
    });
  },
);
