import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * U2 round 10 (item C): pins for the allow-list's rules lane G's rows
 * leave unpinned (tools/mutate-10.py, Xnn): the drive job's runner label,
 * its timeout, a job's env names, an action's inputs, `with` on a run
 * step, continue-on-error behind a trailing space on any job or step, and
 * an action pinned by a tag. Each passes at the round-10 head.
 */
describe("drives-once pins, round 10 (the allow-list's rules)", function () {
  const yaml = require("js-yaml");
  const { check, drives } = require("../../scripts/ci/drives-once");
  const FILE = path.join(__dirname, "../../.github/workflows/ci.yml");
  const names = drives(path.join(__dirname, "../../scripts/ci"));
  const load = () => yaml.load(fs.readFileSync(FILE, "utf8"));
  const errs = (doc: any) => check(doc, names).join("\n");

  it("V11 (kills X13): a self-hosted runner label on a drive job is refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"]["runs-on"] = "self-hosted";
    expect(errs(doc)).to.contain(
      "deploy-drives job runs on self-hosted, not a GitHub-hosted ubuntu label",
    );
  });

  it("V21 (kills X14): a drive job's timeout of 0 is refused by name", function () {
    const doc = load();
    doc.jobs.demo["timeout-minutes"] = 0;
    expect(errs(doc)).to.contain("demo job timeout-minutes is not above 0");
  });

  it("kills X15: an unknown env name on a drive job is refused by name; demo's own pass", function () {
    const doc = load();
    doc.jobs.demo.env.BASH_ENV = "/tmp/x";
    expect(errs(doc)).to.equal("demo job sets env BASH_ENV");
  });

  it("V20 (kills X18, X19): an input the action does not take, or `with` on a run step, is refused by name", function () {
    const doc = load();
    const co = doc.jobs["deploy-drives"].steps[0];
    co.with.repository = "someone/else";
    const run = doc.jobs.demo.steps.find((x: any) => x.run);
    run.with = { skip: true };
    const got = errs(doc);
    expect(got).to.contain(
      `deploy-drives step "${co.uses}" with sets repository`,
    );
    expect(got).to.contain(`demo step "${run.name}" sets with`);
  });

  it("kills X22, X23: continue-on-error behind a trailing space on another job or its step is refused", function () {
    const doc = load();
    doc.jobs.tests["continue-on-error "] = true;
    doc.jobs.gates.steps[0]["continue-on-error "] = true;
    const got = errs(doc);
    expect(got).to.contain("tests job sets continue-on-error");
    expect(got).to.contain("gates step");
  });

  it("kills X30: an action pinned by a tag, not a commit SHA, is refused by name", function () {
    const doc = load();
    doc.jobs["deploy-drives"].steps[0].uses = "actions/checkout@v4";
    expect(errs(doc)).to.contain(
      `deploy-drives step "actions/checkout@v4" uses actions/checkout@v4`,
    );
  });
});
