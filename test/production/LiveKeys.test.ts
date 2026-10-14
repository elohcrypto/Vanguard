import { expect } from "chai";
import { execFileSync } from "child_process";
import { refuseTestKeys } from "../../hardhat.config";

const PHRASE = "test test test test test test test test test test test junk";
// Hardhat's published account 0 and 19 keys.
const KEY0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY19 =
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e";
const OWN = "0x" + "11".repeat(32);

// Task 5.6b round 4 (R-56c-6): sepolia and mainnet refuse the published
// Hardhat test phrase and its keys; a local network keeps them (the
// runbook's rehearsal sets MNEMONIC to the phrase).
describe("Live networks refuse the Hardhat test phrase (R-56c-6)", function () {
  it("refuses the phrase and its keys on sepolia and mainnet only", function () {
    for (const net of ["sepolia", "mainnet"]) {
      for (const accounts of [
        { mnemonic: PHRASE },
        { mnemonic: ` ${PHRASE.toUpperCase().replace(/ /g, "  ")} ` },
        [KEY0],
        [OWN, KEY19],
      ]) {
        expect(() => refuseTestKeys(net, accounts)).to.throw(
          `refusing --network ${net}: MNEMONIC / PRIVATE_KEY is the published Hardhat test phrase`,
        );
      }
      expect(() => refuseTestKeys(net, [OWN])).to.not.throw();
      expect(() => refuseTestKeys(net, [])).to.not.throw();
    }
    for (const net of ["hardhat", "localhost", "demo"])
      expect(() => refuseTestKeys(net, { mnemonic: PHRASE })).to.not.throw();
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
});
