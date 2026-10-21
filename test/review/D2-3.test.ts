// D2-3: a governance deployed with a demo TIME_SCALE (1440) is refused by
// the handover's preflight, full phase and day-2 audit on a chain that is
// NOT 31337 (here the in-process node answers as Sepolia, 11155111), not
// only by the deploy (scripts/production/deployConfig.ts refuseTimeScale).
// This file runs twice: under the project config it starts itself again
// as a child `hardhat test` under D2-3.hardhat.config.ts, whose
// in-process node is chain 11155111, and that run checks the refusals.
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { spawnSync } from "child_process";
import { handoverFixture } from "../helpers/governanceFixture";
import { runHandover } from "../../scripts/handover";
import { refuseTimeScale } from "../../scripts/production/deployConfig";
import { pinsFor } from "../../scripts/production/walletPins";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
const {
  maskedCodeHash,
  expectedHash,
} = require("../../demo/utils/HandoverCodeHash");
const { describeUnlessCoverage } = require("../helpers/zkProofs") as {
  describeUnlessCoverage: (
    title: string,
    reason: string,
    fn: (this: Mocha.Suite) => void,
  ) => void;
};

const SEPOLIA = 11155111;
const CONFIG = path.join(__dirname, "D2-3.hardhat.config.ts");

describeUnlessCoverage(
  "D2-3 demo TIME_SCALE is refused off the dev chain",
  "its child `hardhat test` reads artifacts/, which coverage instruments",
  function () {
    this.timeout(600000);
    if (network.config.chainId !== SEPOLIA) {
      it("runs the chain-11155111 half in a child hardhat test", function () {
        const env = { ...process.env };
        for (const k of [
          "TEST_SHARD",
          "TEST_SHARD_RUN",
          "MOCHA_TIMINGS",
          "MOCHA_PENDING",
        ])
          delete env[k];
        const r = spawnSync(
          "npx",
          ["hardhat", "--config", CONFIG, "test", "--no-compile", __filename],
          {
            encoding: "utf8",
            env,
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        console.log(
          r.stdout
            .split("\n")
            .filter((l) => /^ {6}\S|passing|failing/.test(l))
            .join("\n"),
        );
        expect(r.status, `${r.stdout}\n${r.stderr}`).to.equal(0);
        expect(r.stdout).to.match(/\b1 passing\b/);
      });
      return;
    }
    it("preflight, completion and audit refuse TIME_SCALE 1440 on chain 11155111", async function () {
      const f = await handoverFixture();
      const chainId = Number((await ethers.provider.getNetwork()).chainId);
      const scale = await f.c.governance.TIME_SCALE();
      const age = await f.c.governance.minVoterAge();
      const votePeriod = (await f.c.governance.proposalThresholds(0))
        .votingPeriod;
      console.log(
        `      chain id ${chainId} (network config ${network.config.chainId}); governance TIME_SCALE ${scale}; minVoterAge ${age}s; InvestorTypeConfig votingPeriod ${votePeriod}s (mainnet schedule: 604800)`,
      );
      expect(chainId).to.equal(SEPOLIA);
      expect(scale).to.equal(1440n);

      // The deploy side refuses it off a dev chain too.
      let deployRefusal = "";
      try {
        refuseTimeScale(chainId, { GOV_TIME_SCALE: "1440" });
      } catch (e: any) {
        deployRefusal = e.message;
      }
      console.log(
        `      deploy guard refuseTimeScale(${chainId}, 1440): ${deployRefusal}`,
      );
      expect(deployRefusal).to.contain(
        "refusing to deploy: GOV_TIME_SCALE=1440",
      );

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-3-"));
      const cfgPath = path.join(dir, "handover.json");
      const a = async (k: string) => f.c[k].getAddress();
      const cfg: any = {
        token: await a("token"),
        governanceToken: await a("governanceToken"),
        identityRegistry: await a("identityRegistry"),
        complianceRules: await a("complianceRules"),
        oracleManager: await a("oracleManager"),
        governance: f.govAddr,
        investorTypeRegistry: await a("investorTypeRegistry"),
        dynamicListManager: await a("dynamicListManager"),
        escrowWalletFactory: await a("escrowWalletFactory"),
        onchainIDFactory: await a("onchainIDFactory"),
        privacyManager: await a("privacyManager"),
        zkVerifier: await a("zkVerifier"),
        oracles: [await f.args.oracles[0].getAddress()],
        issuers: [await f.args.issuers[0].getAddress()],
        fromBlock: f.args.fromBlock,
        logChunk: 100,
        feeWallets: [f.feeWallet.address],
        ops: 1,
        guardian: 2,
        issuerAdmin: 7,
        proposer: 4,
        voters: [5, 6],
      };
      // Off 31337 the CLI requires wallet pins.
      cfg.accounts = pinsFor(
        cfg,
        (await ethers.getSigners()).map((x) => x.address),
      );
      const quiet = console.log;
      const out: string[] = [];
      console.log = (...m: any[]) => out.push(m.join(" "));
      let pre = "ok";
      let full = "ok";
      let audit = "ok";
      try {
        await runHandover(cfg, "preflight", cfgPath).catch(
          (e: any) => (pre = e.message),
        );
        await runHandover(cfg, "full", cfgPath).catch(
          (e: any) => (full = e.message),
        );
        await runHandover(cfg, "audit", cfgPath).catch(
          (e: any) => (audit = e.message),
        );
      } finally {
        console.log = quiet;
      }
      console.log(
        `      preflight: ${pre}\n      full phase: ${full}\n      audit: ${audit}`,
      );
      const refusal = `governance TIME_SCALE is 1440 on chain ${SEPOLIA}`;
      expect(pre).to.contain(refusal);
      expect(full).to.contain(refusal);
      expect(audit).to.contain("the ceremony has not completed");
      expect(await f.c.identityRegistry.owner()).to.equal(f.deployer.address);
      expect(await f.c.governance.TIME_SCALE()).to.equal(1440n);

      // The code pin masks the immutable: governance at 1 and at 1440 have
      // different runtime code but the same masked hash, both = compiled.
      const mk = async (s: number) =>
        (
          await (
            await ethers.getContractFactory("VanguardGovernance")
          ).deploy(
            await f.c.governanceToken.getAddress(),
            await f.c.identityRegistry.getAddress(),
            await f.c.investorTypeRegistry.getAddress(),
            await f.c.complianceRules.getAddress(),
            await f.c.oracleManager.getAddress(),
            await f.c.token.getAddress(),
            s,
          )
        ).getAddress();
      const g1 = await mk(1);
      const raw = async (x: string) =>
        ethers.keccak256(await ethers.provider.getCode(x));
      const want = await expectedHash("VanguardGovernance");
      expect(await raw(g1)).to.not.equal(await raw(f.govAddr));
      expect(await maskedCodeHash(g1, "VanguardGovernance")).to.equal(want);
      expect(await maskedCodeHash(f.govAddr, "VanguardGovernance")).to.equal(
        want,
      );
    });
  },
);
