// Review D-5 (ported from the reviewer's P-D-5.test.ts, inverted):
// print-role-wallets labels the wallets as the production deploy's
// defaults use them, and a freshly generated phrase goes to a new 0600
// file, never to stdout.
import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveInputs } from "../../scripts/production/deployConfig";

const HARDHAT_PHRASE =
  "test test test test test test test test test test test junk"; // published, public
const run = (env: Record<string, string | undefined>) => {
  const e: any = { ...process.env, ...env };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete e[k];
  return spawnSync(
    "npx",
    [
      "hardhat",
      "run",
      "--no-compile",
      "scripts/print-role-wallets.js",
      "--network",
      "hardhat",
    ],
    { env: e, encoding: "utf8", timeout: 120000 },
  );
};
const rows = (stdout: string) => {
  const label: Record<number, string> = {};
  const accounts: string[] = [];
  for (const l of stdout.split("\n")) {
    const m = l.match(/^\s*(\d+)\s{2}(.+?)\s+(0x[0-9a-fA-F]{40})\s/);
    if (m) {
      label[Number(m[1])] = m[2].trim();
      accounts[Number(m[1])] = m[3];
    }
  }
  return { label, accounts };
};

describe("D-5 print-role-wallets follows the deploy defaults", function () {
  this.timeout(300000);
  let dir: string;
  before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "d5-"))));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("labels each wallet with the role the production deploy gives it by default", function () {
    const r = run({ MNEMONIC: HARDHAT_PHRASE });
    expect(r.status, r.stderr).to.equal(0);
    const { label, accounts } = rows(r.stdout);
    expect(accounts.length).to.equal(12);
    const d = resolveInputs(
      { attestor: { Ax: "1", Ay: "1" } } as any,
      11155111,
      accounts,
    ) as any;
    const idx = (a: string) =>
      accounts.findIndex((x) => x.toLowerCase() === a.toLowerCase());
    expect(label[0]).to.match(/deployer/);
    for (const n of d.oracleNodes)
      expect(label[idx(n)]).to.match(/oracle node/);
    expect(label[idx(d.proposer)]).to.match(/proposer/);
    for (const v of d.voters) expect(label[idx(v)]).to.match(/voter/);
    expect(label[idx(d.escrowFeeWallet)]).to.match(/escrow fee wallet/);
    expect(label[idx(d.issuerAdmin)]).to.match(/issuer admin/);
    expect(label[idx(d.ops)]).to.match(/^ops$/);
    expect(label[idx(d.guardian)]).to.match(/guardian/);
    expect(
      Object.values(label).filter((l) => /fee wallet/.test(l)),
    ).to.have.length(1);
  });

  it("writes a fresh phrase to a new 0600 file, not to stdout, and never overwrites it", function () {
    const file = path.join(dir, "mnemonic");
    const r = run({ MNEMONIC: undefined, MNEMONIC_FILE: file });
    expect(r.status, r.stderr).to.equal(0);
    const saved = fs
      .readFileSync(file, "utf8")
      .match(/^MNEMONIC="([a-z]+(?: [a-z]+){11})"$/m);
    expect(saved, 'the phrase file holds MNEMONIC="<12 words>"').to.not.equal(
      null,
    );
    expect(saved![1]).to.not.equal(HARDHAT_PHRASE);
    expect(fs.statSync(file).mode & 0o777).to.equal(0o600);
    expect(r.stdout).to.not.contain(saved![1]);
    expect(r.stderr).to.not.contain(saved![1]);
    expect(rows(r.stdout).accounts.length).to.equal(12);

    const again = run({ MNEMONIC: undefined, MNEMONIC_FILE: file });
    expect(again.status).to.not.equal(0);
    expect(again.stderr + again.stdout).to.contain(`${file} exists`);
    expect(fs.readFileSync(file, "utf8")).to.contain(saved![1]);
  });
});
