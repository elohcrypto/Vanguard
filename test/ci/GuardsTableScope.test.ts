import { expect } from "chai";

/**
 * Task 5.17 slice A (deep review H-1): scripts/ci/guards-table.js counts a
 * tested row only if its it() runs. The TITLE regex sees the it( text,
 * not its scope; titlesOf parses the file and marks an it() under a
 * skip or a focus `off`, on fixture strings here.
 */
describe("guards-table: it() scope", function () {
  const { titlesOf } = require("../../scripts/ci/guards-table.js");
  const offOf = (src: string, file = "f.test.ts") =>
    Object.fromEntries(titlesOf(src, file).map((t: any) => [t.title, t.off]));

  it("marks every it() under describe.skip, xdescribe, context.skip, xcontext", function () {
    const src = [
      `describe("live", function () {`,
      `  it("a", async () => {});`,
      `  describe.skip("gone", function () {`,
      `    describe("inner", () => { it("b", () => {}); });`,
      `    it("c", () => {});`,
      `  });`,
      `  it("d", () => {});`,
      `});`,
      `xdescribe("x", () => { it("e", () => {}); });`,
      `context.skip("cs", () => { it("f", () => {}); });`,
      `xcontext("xc", () => { it("g", () => {}); });`,
    ].join("\n");
    expect(offOf(src)).to.deep.equal({
      a: "",
      b: "describe.skip",
      c: "describe.skip",
      d: "",
      e: "xdescribe",
      f: "context.skip",
      g: "xcontext",
    });
  });

  it("marks a focus left in (describe.only, context.only), outermost form named", function () {
    const src = [
      `describe.only("focus", function () {`,
      `  it("a", () => {});`,
      `  describe.skip("both", () => { it("b", () => {}); });`,
      `});`,
      `context.only("c", () => { it("c", () => {}); });`,
      `describe("plain", () => { it("d", () => {}); });`,
    ].join("\n");
    expect(offOf(src, "f.test.js")).to.deep.equal({
      a: "describe.only",
      b: "describe.only",
      c: "context.only",
      d: "",
    });
  });

  it("still excludes it.skip and xit, and a title that only looks like a skip is live", function () {
    const src = [
      `describe("s", function () {`,
      `  it.skip("skipped", () => {});`,
      `  xit("x'd", () => {});`,
      `  it("mentions describe.skip( in its title", () => {`,
      `    const s = "describe.skip(";`,
      `  });`,
      `});`,
    ].join("\n");
    expect(offOf(src)).to.deep.equal({
      "mentions describe.skip( in its title": "",
    });
  });

  it("finds the guard tests live in the tree (no skipped guard suite)", function () {
    const fs = require("fs");
    const file = "test/erc3643/RegistryGuards.test.ts";
    const titles = titlesOf(fs.readFileSync(file, "utf8"), file);
    expect(titles.length).to.be.greaterThan(20);
    expect(titles.filter((t: any) => t.off)).to.deep.equal([]);
  });
});
