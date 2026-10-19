import { expect } from "chai";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { handoverArgs } from "../../scripts/handoverConfig";
import {
  checkWallets,
  pinsFor,
  usedIndices,
} from "../../scripts/production/walletPins";
import { writeHandoverConfig } from "../../scripts/production/deployHandover";

/**
 * Task 5.17 slice B (deep review M-2): handover.json pins every wallet
 * index it uses to an address ("accounts"), and every phase and CLI
 * refuses, before any send, a signer whose wallet at a pinned index is
 * another key, or whose wallet 0 is not the named deploy record's
 * deployer. The shifted keystore directory itself, through
 * scripts/production/signer.js and each CLI, is in WalletPinsCli.test.ts.
 */
describe("handover.json wallet pins (M-2)", function () {
  const cfg = {
    governance: ethers.ZeroAddress,
    ops: 1,
    guardian: 2,
    issuerAdmin: "0x000000000000000000000000000000000000dEaD",
    proposer: 4,
    voters: [5, 6],
  };
  let wallets: { address: string }[];
  before(async () => {
    wallets = await ethers.getSigners();
  });
  const addresses = () => wallets.map((w) => w.address);

  it("pins exactly the indices it uses (an external role is an address, no index)", function () {
    expect([...usedIndices(cfg).entries()]).to.deep.equal([
      [0, ["deployer"]],
      [1, ["ops"]],
      [2, ["guardian"]],
      [4, ["proposer"]],
      [5, ["voter"]],
      [6, ["voter"]],
    ]);
    expect(Object.keys(pinsFor(cfg, addresses()))).to.deep.equal([
      "0",
      "1",
      "2",
      "4",
      "5",
      "6",
    ]);
  });

  it("passes the pinned signer; refuses a shifted one naming the index and both addresses", function () {
    const pinned = { ...cfg, accounts: pinsFor(cfg, addresses()) };
    expect(() =>
      checkWallets(pinned, wallets, "h.json", 11155111, null),
    ).to.not.throw();
    // A keystore that sorts first: every index now names the key before.
    const shifted = [{ address: wallets[19].address }, ...wallets];
    expect(() =>
      checkWallets(pinned, shifted, "h.json", 11155111, null),
    ).to.throw(
      `h.json: wallet 0 (deployer) is ${wallets[19].address} but "accounts" pins ${wallets[0].address}: the signer's keystores changed (a file added, removed or renamed?); refusing before any send`,
    );
    const one = [...wallets];
    one[5] = wallets[9];
    expect(() => checkWallets(pinned, one, "h.json", 11155111, null)).to.throw(
      `wallet 5 (voter) is ${wallets[9].address} but "accounts" pins ${wallets[5].address}`,
    );
  });

  it("requires the pins off the dev chain and with a record; wallet 0 must be the record's deployer", function () {
    expect(() => checkWallets(cfg, wallets, "h.json", 11155111, null)).to.throw(
      /h\.json: no "accounts" pins \(wallet index -> address\), required on chain 11155111/,
    );
    const record = {
      file: "deployments/31337.json",
      deployer: wallets[0].address,
    };
    expect(() => checkWallets(cfg, wallets, "h.json", 31337, record)).to.throw(
      /required on chain 31337 and with the deploy record deployments\/31337\.json/,
    );
    // The dev chain without a record: the demo's and tests' configs.
    expect(() =>
      checkWallets(cfg, wallets, "h.json", 31337, null),
    ).to.not.throw();
    const pinned = { ...cfg, accounts: pinsFor(cfg, addresses()) };
    expect(() =>
      checkWallets(pinned, wallets, "h.json", 31337, {
        file: "r.json",
        deployer: wallets[3].address,
      }),
    ).to.throw(
      `wallet 0 is ${wallets[0].address} but the deploy record r.json names the deployer ${wallets[3].address}: refusing before any send`,
    );
    expect(() =>
      checkWallets({ ...cfg, accounts: [] }, wallets, "h.json", 31337, null),
    ).to.throw(/"accounts" must map wallet indices to addresses/);
  });

  it("every phase reads handover.json through the check (handoverArgs, DEPLOY_RECORD named)", async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"));
    const was = process.env.DEPLOY_RECORD;
    try {
      const rec = path.join(dir, "31337.json");
      fs.writeFileSync(
        rec,
        JSON.stringify({
          version: 1,
          chainId: 31337,
          deployer: wallets[0].address,
          txs: [],
        }),
      );
      process.env.DEPLOY_RECORD = rec;
      await expect(handoverArgs(cfg, "accept", "h.json")).to.be.rejectedWith(
        /no "accounts" pins/,
      );
      const moved = { ...pinsFor(cfg, addresses()), "4": wallets[8].address };
      await expect(
        handoverArgs({ ...cfg, accounts: moved }, "audit", "h.json"),
      ).to.be.rejectedWith(
        `wallet 4 (proposer) is ${wallets[4].address} but "accounts" pins ${wallets[8].address}`,
      );
    } finally {
      if (was === undefined) delete process.env.DEPLOY_RECORD;
      else process.env.DEPLOY_RECORD = was;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the production deploy writes the pins (deployHandover.handoverConfig)", async function () {
    const {
      handoverConfig,
    } = require("../../scripts/production/deployHandover");
    const a = addresses();
    const out = handoverConfig(
      {
        deployer: a[0],
        ops: a[1],
        guardian: a[2],
        issuerAdmin: a[3],
        proposer: a[4],
        voters: [a[5], a[6]],
        external: [],
        oracleNodes: [],
        attestor: { Ax: "1" },
        escrowFeeWallet: a[7],
      },
      { vanguardGovernance: a[8] },
      a,
      1,
      100,
    );
    expect(out.accounts).to.deep.equal({
      "0": a[0],
      "1": a[1],
      "2": a[2],
      "3": a[3],
      "4": a[4],
      "5": a[5],
      "6": a[6],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pins-"));
    writeHandoverConfig(path.join(dir, "h.json"), out);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
