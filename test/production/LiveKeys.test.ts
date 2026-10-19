import { expect } from "chai";
import { execFileSync, spawn } from "child_process";
import { fakeUpstream } from "../helpers/signerProcess";
import { refuseTestKeys } from "../../hardhat.config";
const { describeUnlessCoverage } = require("../helpers/zkProofs");

const PHRASE = "test test test test test test test test test test test junk";
// Hardhat's published account 0 and 19 keys.
const KEY0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY19 =
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e";
const OWN = "0x" + "11".repeat(32);

// Task 5.6b round 4 (R-56c-6): live networks refuse the published Hardhat
// test phrase and its keys; the dev chain keeps them (the runbook's
// rehearsal sets MNEMONIC to the phrase). Task 5.17 (deep review L-7):
// keyed on the chain id, not the network's name.
describe("Live networks refuse the Hardhat test phrase (R-56c-6)", function () {
  it("refuses the phrase and its keys on every chain but 31337", function () {
    for (const [net, chain] of [
      ["sepolia", 11155111],
      ["mainnet", 1],
      ["localhost", 11155111],
      ["custom", 10],
    ] as const) {
      for (const accounts of [
        { mnemonic: PHRASE },
        { mnemonic: ` ${PHRASE.toUpperCase().replace(/ /g, "  ")} ` },
        [KEY0],
        [OWN, KEY19],
      ]) {
        expect(() => refuseTestKeys(net, accounts, chain)).to.throw(
          `refusing --network ${net} (chain ${chain}): MNEMONIC / PRIVATE_KEY is the published Hardhat test phrase`,
        );
      }
      expect(() => refuseTestKeys(net, [OWN], chain)).to.not.throw();
      expect(() => refuseTestKeys(net, [], chain)).to.not.throw();
    }
    for (const net of ["hardhat", "localhost", "devnode", "sepolia"])
      expect(() =>
        refuseTestKeys(net, { mnemonic: PHRASE }, 31337),
      ).to.not.throw();
  });
});

// Not under coverage: a child `hardhat run` compiles first (and
// --no-compile is passed too), and a recompile overwrites the
// instrumented artifacts/ mid-run (Task 5.17, CI run 39308877486).
describeUnlessCoverage(
  "Live networks refuse the Hardhat test phrase: the CLI (R-56c-6)",
  "its child `hardhat run` processes would recompile the real build over the instrumented artifacts",
  function () {
    it("refuses a network with no chain configured; a node configured 31337 on another chain stops at HH101", async function () {
      this.timeout(180000);
      expect(() =>
        refuseTestKeys("custom", { mnemonic: PHRASE }, undefined),
      ).to.throw(
        "refusing --network custom (chain not configured): MNEMONIC / PRIVATE_KEY is the published Hardhat test phrase",
      );
      // devnode is configured 31337; pointed at a Sepolia node, Hardhat's
      // chain check stops the run at its first call, before any send.
      const up = await fakeUpstream(11155111);
      try {
        const out = await new Promise<{ code: number | null; text: string }>(
          (ok) => {
            const p = spawn(
              "npx",
              [
                "hardhat",
                "--network",
                "devnode",
                "run",
                "--no-compile",
                "scripts/print-role-wallets.js",
              ],
              {
                env: { ...process.env, MNEMONIC: PHRASE, DEMO_RPC_URL: up.url },
              },
            );
            let text = "";
            p.stdout.on("data", (d) => (text += d));
            p.stderr.on("data", (d) => (text += d));
            p.on("exit", (code) => ok({ code, text }));
          },
        );
        expect(out.code).to.equal(1);
        expect(out.text).to.include(
          "HH101: Hardhat was set to use chain id 31337, but connected to a chain with id 11155111",
        );
        expect(up.raws).to.deep.equal([]);
      } finally {
        up.server.close();
      }
    });

    it("is wired: hardhat --network sepolia with the phrase stops before any script", function () {
      this.timeout(180000);
      let err = "";
      try {
        execFileSync(
          "npx",
          [
            "hardhat",
            "--network",
            "sepolia",
            "run",
            "--no-compile",
            "scripts/print-role-wallets.js",
          ],
          {
            env: {
              ...process.env,
              MNEMONIC: PHRASE,
              SEPOLIA_RPC_URL: "http://127.0.0.1:1",
            },
            stdio: "pipe",
            encoding: "utf8",
          },
        );
      } catch (e: any) {
        err = String(e.stderr) + String(e.stdout);
      }
      expect(err).to.include("refusing --network sepolia");
    });
  },
);
