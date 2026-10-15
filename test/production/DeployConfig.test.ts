import { expect } from "chai";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { getAddress, Wallet } from "ethers";
import {
  refuseLocalKeys,
  refuseTimeScale,
  resolveInputs,
} from "../../scripts/production/deployConfig";
const { describeUnlessCoverage } = require("../helpers/zkProofs") as {
  describeUnlessCoverage: (
    title: string,
    reason: string,
    fn: (this: Mocha.Suite) => void,
  ) => void;
};

/**
 * Plan v2 Task 5.7: the production deploy holds no key (R-56c-6 carried:
 * by network name AND by the connected chain id), takes defaults only on
 * dev chains and Sepolia, and refuses before any transaction when the
 * external signer lacks a role.
 */
const PHRASE = "test test test test test test test test test test test junk";
const ATTESTOR = { Ax: "1", Ay: "2" };
const accounts = Array.from(
  { length: 12 },
  (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
);
const env = (e: Record<string, string>) => e;

describe("Production deploy inputs and key refusal (Task 5.7)", function () {
  it("refuses a key in the process by network name, then by chain id", function () {
    const key = Wallet.createRandom().privateKey;
    const refuse = (p: any) => () => refuseLocalKeys(p);
    expect(
      refuse({
        network: "sepolia",
        accounts: [key],
        env: env({ PRIVATE_KEY: key }),
      }),
    ).to.throw('refusing to deploy: PRIVATE_KEY set for network "sepolia"');
    expect(
      refuse({
        network: "remote",
        chainId: 31337,
        accounts: "remote",
        env: env({ MNEMONIC: PHRASE }),
      }),
    ).to.throw('MNEMONIC set for network "remote" (chain 31337)');
    // devnode may hold the phrase on a dev chain only.
    expect(
      refuse({
        network: "devnode",
        chainId: 11155111,
        accounts: { mnemonic: PHRASE },
        env: env({ MNEMONIC: PHRASE }),
      }),
    ).to.throw('MNEMONIC set for network "devnode" (chain 11155111)');
    // Local accounts with nothing in the environment: by chain id.
    expect(
      refuse({ network: "devnode", chainId: 1, accounts: [key], env: {} }),
    ).to.throw(
      'network "devnode" holds local accounts and chain 1 is not a local dev chain',
    );
    expect(
      refuse({
        network: "custom",
        chainId: 137,
        accounts: { mnemonic: PHRASE },
        env: {},
      }),
    ).to.throw("chain 137 is not a local dev chain");
    for (const ok of [
      {
        network: "devnode",
        chainId: 31337,
        accounts: { mnemonic: PHRASE },
        env: env({ MNEMONIC: PHRASE }),
      },
      { network: "hardhat", chainId: 31337, accounts: {}, env: {} },
      {
        network: "localhost",
        chainId: 1337,
        accounts: [key],
        env: env({ PRIVATE_KEY: key }),
      },
      { network: "remote", chainId: 1, accounts: "remote", env: {} },
    ]) {
      expect(refuse(ok)).to.not.throw();
    }
  });

  it("refuses a governance time scale off a dev chain", function () {
    expect(() => refuseTimeScale(11155111, { GOV_TIME_SCALE: "336" })).to.throw(
      "GOV_TIME_SCALE=336 on chain 11155111",
    );
    expect(() =>
      refuseTimeScale(31337, { GOV_TIME_SCALE: "336" }),
    ).to.not.throw();
    expect(() => refuseTimeScale(1, { GOV_TIME_SCALE: "1" })).to.not.throw();
  });

  it("defaults roles to the signer's TESTNET_SETUP wallets on dev chains and Sepolia", function () {
    for (const chain of [31337, 11155111]) {
      const i = resolveInputs({ attestor: ATTESTOR }, chain, accounts);
      expect(i.deployer).to.equal(accounts[0]);
      expect(i.oracleNodes).to.deep.equal(accounts.slice(1, 4));
      expect([i.proposer, i.voters]).to.deep.equal([
        accounts[4],
        accounts.slice(5, 7),
      ]);
      expect([i.issuerAdmin, i.ops, i.guardian]).to.deep.equal(
        accounts.slice(9, 12),
      );
      expect(i.oracleOperator).to.equal(i.ops);
      expect(i.escrowFeeWallet).to.equal(accounts[1]);
      expect(i.lockAmounts).to.equal(null);
    }
    expect(
      resolveInputs({ attestor: ATTESTOR }, 31337, accounts).confirmations,
    ).to.equal(1);
    expect(
      resolveInputs(
        { attestor: ATTESTOR, lockAmounts: ["2000", "4000", "8000"] },
        31337,
        accounts,
      ).lockAmounts,
    ).to.deep.equal([2000n, 4000n, 8000n].map((x) => x * 10n ** 18n));
  });

  it("takes explicit values only on mainnet and unknown chains", function () {
    const full = {
      ops: accounts[10],
      guardian: accounts[11],
      issuerAdmin: accounts[9],
      oracleNodes: accounts.slice(1, 4),
      oracleOperator: accounts[10],
      lockAmounts: ["2000", "4000", "8000"],
      proposer: accounts[4],
      voters: accounts.slice(5, 7),
      escrowFeeWallet: accounts[1],
      attestor: ATTESTOR,
    };
    for (const chain of [1, 137]) {
      for (const k of Object.keys(full).filter((x) => x !== "attestor")) {
        const cut: any = { ...full };
        delete cut[k];
        expect(() => resolveInputs(cut, chain, accounts), k).to.throw(
          `"${k}" is required on chain ${chain}`,
        );
      }
      expect(resolveInputs(full, chain, accounts).confirmations).to.equal(3);
    }
  });

  it("refuses before any transaction what the signer or the ceremony cannot carry", function () {
    const r =
      (raw: any, acc = accounts) =>
      () =>
        resolveInputs(raw, 31337, acc);
    expect(r({ attestor: ATTESTOR }, [])).to.throw(
      "exposes no account (eth_accounts is empty)",
    );
    expect(r({ attestor: ATTESTOR }, accounts.slice(0, 10))).to.throw(
      '"ops" defaults to the signer\'s account 10, which it does not expose',
    );
    const stranger = getAddress("0x00000000000000000000000000000000000000ff");
    expect(r({ attestor: ATTESTOR, ops: stranger })).to.throw(
      `ops ${stranger} is not an account of the external signer`,
    );
    expect(r({ attestor: ATTESTOR, oracleOperator: accounts[9] })).to.throw(
      `"oracleOperator" ${getAddress(accounts[9])} is not ops ${getAddress(accounts[10])}`,
    );
    expect(r({})).to.throw(
      '"attestor" must give the issuer\'s EdDSA public key',
    );
    expect(r({ attestor: ATTESTOR, treasury: stranger })).to.throw(
      'unknown key "treasury"',
    );
    expect(r({ attestor: ATTESTOR, guardian: accounts[10] })).to.throw(
      "four different keys (D25 b)",
    );
    expect(
      r({
        attestor: ATTESTOR,
        oracleNodes: [accounts[1], accounts[1], accounts[2]],
      }),
    ).to.throw("three distinct node keys");
    expect(r({ attestor: ATTESTOR, escrowFeeWallet: accounts[0] })).to.throw(
      "the escrow fee wallet may not be the deployer",
    );
  });
});

describeUnlessCoverage(
  "Production deploy CLI refusals (Task 5.7)",
  "child `hardhat run` processes recompile the real build over the instrumented artifacts",
  function () {
    this.timeout(300_000);
    const port = Number(process.env.DEPLOY_TEST_PORT || 8549);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-cli-"));
    const cfg = path.join(dir, "deploy.json");
    let chain = "0x7a69";
    let served: string[] = [];
    let methods: string[] = [];
    let server: http.Server;

    before(async function () {
      fs.writeFileSync(cfg, JSON.stringify({ attestor: ATTESTOR }));
      server = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          const call = JSON.parse(b);
          methods.push(call.method);
          const result =
            call.method === "eth_chainId"
              ? chain
              : call.method === "eth_accounts"
                ? served
                : call.method === "eth_blockNumber"
                  ? "0x1"
                  : null;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
        });
      });
      await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    });
    after(function () {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(function () {
      methods = [];
    });

    // Async: the fake RPC answers from this process's event loop.
    const deploy = (
      network: string,
      e: Record<string, string>,
    ): Promise<{ status: number | null; out: string }> => {
      const r = spawn(
        "npx",
        [
          "hardhat",
          "run",
          "--no-compile",
          "scripts/production/DeployProduction.ts",
          "--network",
          network,
        ],
        {
          env: {
            ...process.env,
            MNEMONIC: "",
            PRIVATE_KEY: "",
            DEPLOY_CONFIG: cfg,
            ...e,
          },
        },
      );
      let out = "";
      r.stdout.on("data", (c) => (out += c));
      r.stderr.on("data", (c) => (out += c));
      return new Promise((ok) =>
        r.on("close", (status) => ok({ status, out })),
      );
    };
    const rpc = `http://127.0.0.1:${port}`;

    it("refuses a raw key by name before any call, and the phrase on a public chain id", async function () {
      const key = Wallet.createRandom().privateKey;
      const a = await deploy("sepolia", { PRIVATE_KEY: key });
      expect(a.status).to.equal(1);
      expect(a.out).to.include(
        'refusing to deploy: PRIVATE_KEY set for network "sepolia"; keys live only in the external signer',
      );
      chain = "0xaa36a7";
      const b = await deploy("devnode", {
        DEMO_RPC_URL: rpc,
        MNEMONIC: PHRASE,
      });
      expect(b.status).to.equal(1);
      expect(b.out).to.include("connected to a chain with id 11155111");
      expect(methods).to.not.include("eth_sendTransaction");
    });

    it("refuses an empty or role-less external signer, and defaults on mainnet, sending nothing", async function () {
      chain = "0x7a69";
      served = [];
      const a = await deploy("remote", { SIGNER_RPC_URL: rpc });
      expect(a.status).to.equal(1);
      expect(a.out).to.include(
        "the external signer exposes no account (eth_accounts is empty)",
      );
      served = accounts.slice(0, 10);
      const b = await deploy("remote", { SIGNER_RPC_URL: rpc });
      expect(b.out).to.include(
        '"ops" defaults to the signer\'s account 10, which it does not expose',
      );
      chain = "0x1";
      served = accounts;
      const c = await deploy("remote", { SIGNER_RPC_URL: rpc });
      expect(c.out).to.include(
        'deploy config: "ops" is required on chain 1 (no defaults)',
      );
      const d = await deploy("remote", {
        SIGNER_RPC_URL: rpc,
        GOV_TIME_SCALE: "336",
      });
      expect(d.out).to.include("GOV_TIME_SCALE=336 on chain 1");
      for (const r of [b, c, d]) expect(r.status).to.equal(1);
      expect(methods).to.not.include("eth_sendTransaction");
    });
  },
);
