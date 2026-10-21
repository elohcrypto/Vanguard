import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * Review E-3 (Q22): scripts/ci/required-check.js pins the `required`
 * job, the one check branch protection requires. The committed
 * workflow passes; each mutant below leaves a job out or lets a failed
 * or skipped job through protection, and the gate must name the gap.
 */
describe("required check", function () {
  const { check } = require("../../scripts/ci/required-check.js");
  const yaml = require("js-yaml");
  const doc = yaml.load(
    fs.readFileSync(
      path.join(__dirname, "../../.github/workflows/ci.yml"),
      "utf8",
    ),
  );
  const gaps = (edit: (req: any, jobs: any) => void) => {
    const copy = JSON.parse(JSON.stringify(doc));
    edit(copy.jobs.required, copy.jobs);
    return check(copy).join("\n");
  };

  it("passes the committed workflow", function () {
    expect(check(doc)).to.deep.equal([]);
  });

  const mutants: [string, (req: any, jobs: any) => void, string][] = [
    [
      "a need removed",
      (r) => (r.needs = r.needs.filter((n: string) => n !== "guard-runs")),
      "missing: guard-runs",
    ],
    [
      "a need that is not a job",
      (r) => r.needs.push("lint"),
      "not a job: lint",
    ],
    ["a duplicate need", (r) => r.needs.push("tests"), "duplicate: tests"],
    [
      "needs given as a string",
      (r) => (r.needs = r.needs.join(", ")),
      "not a list",
    ],
    ["no required job", (_r, j) => delete j.required, "no `required` job"],
    [
      "an if without always()",
      (r) => (r.if = "${{ !github.event.deleted }}"),
      "required.if is",
    ],
    [
      "an if of !always()",
      (r) => (r.if = "${{ !always() && !github.event.deleted }}"),
      "required.if is",
    ],
    [
      "an if of false && always()",
      (r) => (r.if = "${{ false && always() }}"),
      "required.if is",
    ],
    [
      "an if without the deleted term",
      (r) => (r.if = "${{ always() }}"),
      "required.if is",
    ],
    [
      "continue-on-error",
      (r) => (r["continue-on-error"] = true),
      "continue-on-error",
    ],
    [
      "continue-on-error on the step",
      (r) => (r.steps[0]["continue-on-error"] = true),
      "required.steps[0] sets continue-on-error",
    ],
    [
      "an if on the step",
      (r) => (r.steps[0].if = "${{ false }}"),
      "required.steps[0] sets if",
    ],
    ["a job name", (r) => (r.name = "all green"), "required sets name"],
    [
      "the step run with || true",
      (r) => (r.steps[0].run += " || true"),
      "required.steps[0].run is",
    ],
    [
      "a jq filter that passes skipped jobs",
      (r) =>
        (r.steps[0].run = r.steps[0].run.replace(
          '.result == "success"',
          '.result != "failure"',
        )),
      "required.steps[0].run is",
    ],
    [
      "a second step",
      (r) => r.steps.push({ run: "true" }),
      "required step count is 2, not 1",
    ],
    [
      "RESULTS not read from needs",
      (r) => (r.steps[0].env.RESULTS = "{}"),
      "required.steps[0].env.RESULTS is",
    ],
  ];
  for (const [title, edit, gap] of mutants) {
    it(`names ${title}`, function () {
      expect(gaps(edit)).to.contain(gap);
    });
  }
});
