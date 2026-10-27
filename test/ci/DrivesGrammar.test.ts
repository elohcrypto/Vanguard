import { expect } from "chai";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * U2 round 9 (item E, lane G's GCI1-GCI5 and GCI8): the "Every drive
 * exactly once" gate refused a list of faults and passed the rest. It now
 * reads a grammar: a drive step's run is one line of drive scripts
 * (`scripts/ci/<drive>.sh`, joined by ` && `) and nothing else; drive steps
 * live only in demo and deploy-drives; those jobs and their steps carry no
 * continue-on-error, if, strategy or matrix; continue-on-error appears
 * nowhere else in the workflow. Each lane-G fault, as a copy of ci.yml run
 * through the step's own command as CI runs it, fails by name.
 */
describe("every drive exactly once: the grammar (gates step)", function () {
  this.timeout(60000);
  const yaml = require("js-yaml");
  const ROOT = path.join(__dirname, "../..");
  const CI = fs.readFileSync(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8",
  );
  const load = () => yaml.load(CI);
  const step = load().jobs.gates.steps.find(
    (s: any) => s.name === "Every drive exactly once",
  );

  /** The step's run over workflow `doc` in a scratch tree. */
  function gate(doc: any) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drives-grammar-"));
    try {
      fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, ".github/workflows/ci.yml"),
        typeof doc === "string" ? doc : yaml.dump(doc),
      );
      fs.cpSync(path.join(ROOT, "scripts/ci"), path.join(dir, "scripts/ci"), {
        recursive: true,
      });
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
  const at = (doc: any, job: string, drive: string) =>
    doc.jobs[job].steps.find((x: any) => String(x.run ?? "").includes(drive));
  const refused = (doc: any, ...why: string[]) => {
    const r = gate(doc);
    expect(r.code, r.out).to.equal(1);
    for (const w of why) expect(r.out).to.contain(w);
  };

  it("passes the committed workflow unchanged", function () {
    const r = gate(CI);
    expect(r.code, r.out).to.equal(0);
  });

  it("GCI1: a drive moved to a new job with job-level continue-on-error fails by name", function () {
    const doc = load();
    const moved = doc.jobs["deploy-drives"].steps.pop();
    doc.jobs.extra = {
      needs: "compile",
      "runs-on": "ubuntu-latest",
      "continue-on-error": true,
      steps: [moved],
    };
    doc.jobs.required.needs = [...doc.jobs.required.needs, "extra"];
    refused(
      doc,
      `extra step "${moved.name}" runs a drive outside demo and deploy-drives`,
      "extra job sets continue-on-error",
    );
  });

  it("GCI2: a drive masked with `|| true` fails by name", function () {
    const doc = load();
    const s = at(doc, "demo", "strict-drive");
    s.run = `${s.run} || true`;
    refused(
      doc,
      `demo step "${s.name}" is not a drive line (scripts/ci/<drive>.sh, joined by " && ")`,
      "scripts/ci/strict-drive.sh runs 0 times",
    );
  });

  it("GCI3: a matrix on deploy-drives fails by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"].strategy = { matrix: { shard: [1, 2] } };
    refused(doc, "deploy-drives job sets strategy");
  });

  it("GCI4: a drive piped through tee fails by name", function () {
    const doc = load();
    const s = at(doc, "demo", "whitelist-cli");
    s.run = `${s.run} | tee /tmp/wl.log`;
    refused(
      doc,
      `demo step "${s.name}" is not a drive line`,
      "scripts/ci/whitelist-cli.sh runs 0 times",
    );
  });

  it("GCI5: `false && scripts/ci/deploy-drive.sh` fails by name", function () {
    const doc = load();
    const s = at(doc, "deploy-drives", "deploy-drive");
    s.run =
      "false && scripts/ci/deploy-drive.sh && scripts/ci/multisig-drive.sh";
    refused(
      doc,
      `deploy-drives step "${s.name}" is not a drive line`,
      "scripts/ci/deploy-drive.sh runs 0 times",
    );
  });

  it("GCI8: continue-on-error on the tests job fails by name", function () {
    const doc = load();
    doc.jobs.tests["continue-on-error"] = true;
    refused(doc, "tests job sets continue-on-error");
  });

  it("a strategy on demo, or continue-on-error on a step of another job, fails by name", function () {
    const doc = load();
    doc.jobs.demo.strategy = { matrix: { n: [1] } };
    const s = doc.jobs.gates.steps[0];
    s["continue-on-error"] = true;
    refused(
      doc,
      "demo job sets strategy",
      `gates step "${s.name ?? s.uses ?? s.run}" sets continue-on-error`,
    );
  });

  it("a drive line spread over two lines fails by name", function () {
    const doc = load();
    const s = at(doc, "deploy-drives", "deploy-drive");
    s.run = "scripts/ci/deploy-drive.sh\nscripts/ci/multisig-drive.sh\n";
    refused(doc, `deploy-drives step "${s.name}" is not a drive line`);
  });
});
