import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 7 (R7-C5) and round 8 (lane G's G-CI1): the gates step "Every
 * drive exactly once" fails unless each drive script runs exactly once
 * across the workflow. Each case runs that step's own command, as CI runs
 * it, over a copy of ci.yml with one fault: a whole-line comment naming a
 * dropped drive, a new drive script nothing runs, `continue-on-error` or
 * `if:` on a step of demo or deploy-drives. Each must fail by name.
 */
describe("every drive exactly once (gates step)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const step = yaml
    .load(CI)
    .jobs.gates.steps.find((s: any) => s.name === "Every drive exactly once");

  /** The step's run over `ci` in a scratch tree; `extra` drive scripts added. */
  function gate(ci: string, extra: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-once-"));
    try {
      fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), ci);
      fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(dir, "scripts/ci"), {
        recursive: true,
      });
      for (const f of extra)
        fs.writeFileSync(path.join(dir, "scripts/ci", f), "#!/bin/sh\n");
      fs.symlinkSync(
        path.join(ROOT, "node_modules"),
        path.join(dir, "node_modules"),
      );
      const r = spawnSync("bash", ["-e", "-c", step.run], {
        cwd: dir,
        encoding: "utf8",
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const DRIVES =
    "        run: scripts/ci/deploy-drive.sh && scripts/ci/multisig-drive.sh";
  const edit = (from: string, to: string) => {
    expect(CI, `the fixture's anchor: ${from}`).to.contain(from);
    return CI.replace(from, to);
  };

  it("passes the committed workflow", function () {
    expect(step, "the step").to.not.equal(undefined);
    const r = gate(CI);
    expect(r.code, r.out).to.equal(0);
  });

  it("a dropped drive fails by name", function () {
    const r = gate(edit(DRIVES, "        run: scripts/ci/multisig-drive.sh"));
    expect(r.code).to.equal(1);
    expect(r.out).to.contain("scripts/ci/deploy-drive.sh runs 0 times");
  });

  it("a doubled drive fails by name", function () {
    const r = gate(edit(DRIVES, `${DRIVES} && scripts/ci/deploy-drive.sh`));
    expect(r.code).to.equal(1);
    expect(r.out).to.contain("scripts/ci/deploy-drive.sh runs 2 times");
  });

  it("G-CI1: a dropped drive kept in a whole-line YAML comment fails by name", function () {
    const r = gate(
      edit(
        DRIVES,
        "        # was run: scripts/ci/deploy-drive.sh\n        run: scripts/ci/multisig-drive.sh",
      ),
    );
    expect(r.code, r.out).to.equal(1);
    expect(r.out).to.contain("scripts/ci/deploy-drive.sh runs 0 times");
  });

  it("G-CI1: a dropped drive kept in a shell comment inside its step fails by name", function () {
    const r = gate(
      edit(
        DRIVES,
        "        run: |\n          # was run: scripts/ci/deploy-drive.sh\n          scripts/ci/multisig-drive.sh",
      ),
    );
    expect(r.code, r.out).to.equal(1);
    expect(r.out).to.contain("scripts/ci/deploy-drive.sh runs 0 times");
  });

  it("G-CI1: a new drive script under scripts/ci that no step runs fails by name", function () {
    const r = gate(CI, ["extra-drive.sh"]);
    expect(r.code, r.out).to.equal(1);
    expect(r.out).to.contain("scripts/ci/extra-drive.sh runs 0 times");
  });

  it("G-CI1: continue-on-error on a demo step fails by name", function () {
    const r = gate(
      edit(
        "      - name: Regression demo drives\n",
        "      - name: Regression demo drives\n        continue-on-error: true\n",
      ),
    );
    expect(r.code, r.out).to.equal(1);
    expect(r.out).to.contain(
      'demo step "Regression demo drives" sets continue-on-error',
    );
  });

  it("G-CI1: an if: on a deploy-drives step fails by name", function () {
    const r = gate(
      edit(
        "      - name: Production deploy drives (external signer; multisig roles)\n",
        "      - name: Production deploy drives (external signer; multisig roles)\n        if: false\n",
      ),
    );
    expect(r.code, r.out).to.equal(1);
    expect(r.out).to.contain(
      'deploy-drives step "Production deploy drives (external signer; multisig roles)" sets if',
    );
  });
});
