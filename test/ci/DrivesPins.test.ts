import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * U2 round 9 (item F): lane G's pins for the drive-once gate's rules the
 * round-8 fixtures left unpinned (swarm-8/G/attack-u2r8-cikills.test.js;
 * Pnn kills mutant Gnn of g-mutate8.py). Each passes at 688521d and after
 * round 9's grammar.
 */
describe("drives-once pins (kills G43, G45, G46)", function () {
  const yaml = require("js-yaml");
  const once = require("../../scripts/ci/drives-once");
  const FILE = path.join(__dirname, "../../.github/workflows/ci.yml");
  const dir = path.join(__dirname, "../../scripts/ci");
  const load = () => yaml.load(fs.readFileSync(FILE, "utf8"));

  it("P43: the drive list holds the named drives and every *-drive*.sh", function () {
    const names = once.drives(dir);
    for (const n of [
      "demo-smoke",
      "whitelist-cli",
      "deploy-drive",
      "multisig-drive",
      "strict-drive",
      "regression-drives",
    ])
      expect(names, n).to.include(n);
  });

  it("P45: job-level continue-on-error or if on demo and deploy-drives is refused by name", function () {
    for (const id of ["demo", "deploy-drives"]) {
      for (const k of ["continue-on-error", "if"]) {
        const doc = load();
        doc.jobs[id][k] = k === "if" ? "${{ always() }}" : true;
        expect(
          once.check(doc, once.drives(dir)).join("\n"),
          `${id} ${k}`,
        ).to.contain(`${id} job sets ${k}`);
      }
    }
  });

  it("P46: a longer script name is not the drive's run", function () {
    const doc = load();
    const s = doc.jobs["deploy-drives"].steps.find((x: any) =>
      /deploy-drive/.test(x.run ?? ""),
    );
    s.run = "scripts/ci/deploy-drive.sh.bak && scripts/ci/multisig-drive.sh";
    expect(once.check(doc, once.drives(dir)).join("\n")).to.contain(
      "deploy-drive.sh runs 0 times",
    );
  });
});
