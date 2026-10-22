// Review D-4, round 3 (G2 item 7, F2 LOW-3; ported from the round-2
// attacker's attack-u2r2-lock L1b, L2 and L3, inverted): the keystore
// lock is taken atomically and a dead holder's lock is taken over without
// a race, so two starters never both hold one directory. A lock whose
// holder this signer cannot check (another host, boot or PID namespace)
// or that is not a lock at all (empty, unparsable) is refused with its
// rm, never taken over. The starters are bare `node` children that load
// signerState.js alone, so 300 rounds take seconds.
import { expect } from "chai";
import { spawn, spawnSync, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const STATE = path.resolve(
  __dirname,
  "../../scripts/production/signerState.js",
);
const { holdKeystores } = require(STATE);

// For each keystore dir i: at t0 + i * step, holdKeystores(dir), then one
// line "i HELD <pid>" or "i REFUSED <message>"; holds them until stdin ends.
const CHILD = `
const [mod, t0, step, ...dirs] = process.argv.slice(2);
const { holdKeystores } = require(mod);
process.setMaxListeners(0);
dirs.forEach((dir, i) => {
  while (Date.now() < Number(t0) + i * Number(step)) {}
  try { holdKeystores(dir); console.log(i + " HELD " + process.pid); }
  catch (e) { console.log(i + " REFUSED " + e.message); }
});
console.log("DONE");
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;
// L2: the first read of the lock (after it returns) or the first removal
// of it (before it runs) waits for the gate file; "reached" says it waits.
const DELAY = `
const fs = require("fs");
const { L2_WHERE: where, L2_GATE: gate } = process.env;
let first = true;
const wait = () => {
  fs.writeFileSync(gate + ".reached", "");
  const t = Date.now();
  while (!fs.existsSync(gate) && Date.now() - t < 10000) {}
};
const hook = (name, after) => {
  const f = fs[name];
  fs[name] = function (p, ...rest) {
    const mine = first && String(p).endsWith("signer.lock");
    if (mine) first = false;
    if (mine && !after) wait();
    const r = f.call(fs, p, ...rest);
    if (mine && after) wait();
    return r;
  };
};
if (where === "read") hook("readFileSync", true);
else for (const n of ["rmSync", "unlinkSync"]) hook(n, false);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Field 22 (start time) of /proc/<pid>/stat. */
function startOf(pid: number) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}
const HERE = {
  host: os.hostname(),
  boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  ns: fs.readlinkSync("/proc/self/ns/pid"),
};
const DEAD = 2147483000; // above any pid_max: no such process
// The other host, boot or PID namespace, prefixed to node: a fresh user
// and PID namespace whose next pid is high, so the holder's pid is not a
// low pid that some root process happens to own on this side.
const NS = (next: number) => [
  "unshare",
  "-Upf",
  "--mount-proc",
  "--map-root-user",
  "sh",
  "-c",
  'echo "$0" > /proc/sys/kernel/ns_last_pid && "$@"; exit $?',
  String(next),
];

type Starter = {
  p: ChildProcess;
  done: Promise<string[]>;
  end: () => Promise<void>;
};

describe("D-4 round 3: the keystore lock without races", function () {
  this.timeout(120_000);
  let root: string;
  let child: string;
  let delay: string;
  let n = 0;
  const live: Starter[] = [];

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "d4-lock3-"));
    child = path.join(root, "child.js");
    delay = path.join(root, "delay.js");
    fs.writeFileSync(child, CHILD);
    fs.writeFileSync(delay, DELAY);
  });
  afterEach(async () => {
    await Promise.all(live.splice(0).map((s) => s.end()));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  /** `count` fresh keystore directories (0700). */
  function dirs(count: number) {
    return Array.from({ length: count }, () => {
      const d = path.join(root, `keys-${++n}`);
      fs.mkdirSync(d, { mode: 0o700 });
      return d;
    });
  }
  const lockOf = (d: string) => path.join(d, "signer.lock");

  /** A starter on `ds` (see CHILD), prefixed by `wrap`, node `opts`. */
  function starter(
    ds: string[],
    t0 = 0,
    step = 0,
    o: { wrap?: string[]; node?: string[]; env?: Record<string, string> } = {},
  ): Starter {
    const argv = [
      ...(o.wrap ?? []),
      process.execPath,
      ...(o.node ?? []),
      child,
      STATE,
      String(t0),
      String(step),
      ...ds,
    ];
    const p = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...o.env },
    });
    p.stdin!.on("error", () => {}); // EPIPE once a killed starter is ended
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    const done = new Promise<string[]>((ok, no) => {
      p.stdout!.on("data", () => {
        if (/^DONE$/m.test(out))
          ok(out.split("\n").filter((l) => /^\d+ /.test(l)));
      });
      exited.then(() => no(new Error(`starter exited before DONE: ${out}`)));
    });
    done.catch(() => {}); // awaited by the test; unawaited after a failure
    const s = {
      p,
      done,
      end: async () => {
        p.stdin!.end();
        await exited;
      },
    };
    live.push(s);
    return s;
  }
  /** Locks on `ds` left by a holder that was killed (SIGKILL). */
  async function killedHolder(ds: string[]) {
    const s = starter(ds);
    const lines = await s.done;
    expect(lines.filter((l) => / HELD /.test(l))).to.have.length(ds.length);
    s.p.kill("SIGKILL");
    await s.end();
    for (const d of ds) expect(fs.existsSync(lockOf(d))).to.equal(true);
  }
  /** holdKeystores(d) in this process: the refusal's message, else "HELD". */
  function hold(d: string) {
    try {
      holdKeystores(d);
      return "HELD";
    } catch (e: any) {
      return e.message as string;
    }
  }

  it("L1b: 300 simultaneous takeovers of a killed holder's lock never hold twice", async function () {
    const ds = dirs(300);
    await killedHolder(ds);
    const t0 = Date.now() + 1000;
    const S = [0, 1, 2, 3].map(() => starter(ds, t0, 4));
    const outs = await Promise.all(S.map((s) => s.done));
    const held = ds.map(() => 0);
    for (const l of outs.flat())
      if (/ HELD /.test(l)) held[Number(l.split(" ")[0])]++;
    const rounds = (k: number) => held.filter((h) => h === k).length;
    expect(
      { double: held.filter((h) => h > 1).length, none: rounds(0) },
      "rounds where two or more starters held the lock, and where none did",
    ).to.deep.equal({ double: 0, none: 0 });
    expect(rounds(1)).to.equal(300);
  });

  for (const where of ["read", "rm"]) {
    it(`L2 (${where}): a starter delayed after it ${where === "read" ? "read the dead lock" : "judged the lock dead, before its removal"} never removes the lock another took`, async function () {
      const [d] = dirs(1);
      await killedHolder([d]);
      const gate = path.join(root, `gate-${++n}`);
      const B = starter([d], 0, 0, {
        node: ["-r", delay],
        env: { L2_WHERE: where, L2_GATE: gate },
      });
      for (let t = 0; !fs.existsSync(`${gate}.reached`); t++) {
        expect(t, "B reached the delayed step").to.be.below(200);
        await sleep(50);
      }
      const A = starter([d]);
      const [a] = await A.done;
      fs.writeFileSync(gate, "go");
      const [b] = await B.done;
      const held = [a, b].filter((l) => / HELD /.test(l));
      expect(held, `A: ${a} | B: ${b}`).to.have.length(1);
      const pid = held[0].split(" ")[2];
      expect(fs.readFileSync(lockOf(d), "utf8")).to.match(
        new RegExp(`\\b${pid}\\b`),
      );
      if (where === "read") {
        expect(a, "A took the dead lock while B waited").to.equal(
          `0 HELD ${A.p.pid}`,
        );
        expect(b).to.match(
          new RegExp(`^0 REFUSED ${lockOf(d)} is held by pid ${A.p.pid} `),
        );
      }
    });
  }

  /** The `unshare` the L3 cases need, and a pid free on this side. */
  function nsReady() {
    const r = spawnSync(
      "unshare",
      ["-Upf", "--mount-proc", "--map-root-user", "true"],
      { encoding: "utf8" },
    );
    expect(
      r.status,
      `unshare -Upf --mount-proc --map-root-user runs a holder in another PID namespace: ${r.error ?? r.stderr}`,
    ).to.equal(0);
    const max = Number(fs.readFileSync("/proc/sys/kernel/pid_max", "utf8"));
    for (let next = max - 1000; ; next--) {
      try {
        process.kill(next + 1, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") return next;
      }
    }
  }

  it("L3: a second start in another PID namespace is refused while the first holds", async function () {
    const next = nsReady();
    const [d] = dirs(1);
    const A = starter([d]);
    const [a] = await A.done;
    expect(a).to.match(/^0 HELD /);
    const before = fs.readFileSync(lockOf(d), "utf8");
    const [b] = await starter([d], 0, 0, { wrap: NS(next) }).done;
    expect(b).to.match(
      new RegExp(
        `^0 REFUSED ${lockOf(d)} is held by pid ${A.p.pid} on .*another host, boot or PID namespace.*rm ${lockOf(d)}`,
      ),
    );
    expect(fs.readFileSync(lockOf(d), "utf8"), "A's lock untouched").to.equal(
      before,
    );
  });

  it("L3: a lock written in another PID namespace is refused here, not taken over", async function () {
    const next = nsReady();
    const [d] = dirs(1);
    const B = starter([d], 0, 0, { wrap: NS(next) });
    const [b] = await B.done;
    expect(b).to.equal(`0 HELD ${next + 1}`);
    const before = fs.readFileSync(lockOf(d), "utf8");
    const [a] = await starter([d]).done;
    expect(a).to.match(
      new RegExp(
        `^0 REFUSED ${lockOf(d)} is held by pid ${next + 1} on .*another host, boot or PID namespace.*rm ${lockOf(d)}`,
      ),
    );
    expect(fs.readFileSync(lockOf(d), "utf8"), "B's lock untouched").to.equal(
      before,
    );
  });

  for (const [what, text] of [
    ["an empty lock", ""],
    ["an unparsable lock", "not a lock\n"],
    ["a lock of the old format (a bare dead pid)", `${DEAD}\n`],
  ]) {
    it(`${what} is refused with its rm, not taken over`, function () {
      const [d] = dirs(1);
      fs.writeFileSync(lockOf(d), text, { mode: 0o600 });
      expect(hold(d)).to.equal(
        `${lockOf(d)} is not a signer lock (empty or unparsable): refusing to start; if no signer runs on these keystores, rm ${lockOf(d)}`,
      );
      expect(fs.readFileSync(lockOf(d), "utf8")).to.equal(text);
    });
  }

  for (const field of ["host", "boot", "ns"] as const) {
    it(`a lock naming another ${field} is refused with its rm, even when its pid is dead here`, function () {
      const [d] = dirs(1);
      const text =
        JSON.stringify({
          pid: DEAD,
          ...HERE,
          start: "1",
          [field]: "elsewhere",
        }) + "\n";
      fs.writeFileSync(lockOf(d), text, { mode: 0o600 });
      expect(hold(d)).to.match(
        new RegExp(
          `^${lockOf(d)} is held by pid ${DEAD} on .*another host, boot or PID namespace.*: refusing to start.*; if no signer runs there, rm ${lockOf(d)}$`,
        ),
      );
      expect(fs.readFileSync(lockOf(d), "utf8")).to.equal(text);
    });
  }

  it("G06: a holder that runs as another user (pid 1: EPERM) is alive, not taken over", function () {
    const [d] = dirs(1);
    const text = JSON.stringify({ pid: 1, ...HERE, start: startOf(1) }) + "\n";
    fs.writeFileSync(lockOf(d), text, { mode: 0o600 });
    expect(hold(d)).to.equal(
      `${lockOf(d)} is held by pid 1 (a signer running on these keystores): refusing to start a second one; if none runs, rm ${lockOf(d)}`,
    );
    expect(fs.readFileSync(lockOf(d), "utf8")).to.equal(text);
  });

  it("a lock whose pid now runs another process (start time differs) is taken over", function () {
    const [d] = dirs(1);
    const old =
      JSON.stringify({ pid: 1, ...HERE, start: `${Number(startOf(1)) + 1}` }) +
      "\n";
    fs.writeFileSync(lockOf(d), old, { mode: 0o600 });
    expect(hold(d)).to.equal("HELD");
    expect(JSON.parse(fs.readFileSync(lockOf(d), "utf8"))).to.deep.equal({
      pid: process.pid,
      ...HERE,
      start: startOf(process.pid),
    });
  });

  it("a takeover file left by a killed start is refused with its rm, never removed", async function () {
    const [d] = dirs(1);
    await killedHolder([d]);
    const dead = fs.readFileSync(lockOf(d), "utf8");
    const left = dead.replace(/"pid":\d+/, `"pid":${DEAD}`);
    fs.writeFileSync(`${lockOf(d)}.takeover`, left, { mode: 0o600 });
    expect(hold(d)).to.equal(
      `${lockOf(d)}.takeover exists: another signer is taking over ${lockOf(d)}, or was killed doing so: refusing to start; if none is starting, rm ${lockOf(d)}.takeover`,
    );
    expect(fs.readFileSync(lockOf(d), "utf8")).to.equal(dead);
    expect(fs.readFileSync(`${lockOf(d)}.takeover`, "utf8")).to.equal(left);
  });

  it("a dangling link at the lock is refused with its rm (the start ends)", function () {
    const [d] = dirs(1);
    fs.symlinkSync(path.join(d, "gone"), lockOf(d));
    expect(hold(d)).to.equal(
      `${lockOf(d)} keeps changing while this signer starts: refusing to start; if no signer runs on these keystores, rm ${lockOf(d)}`,
    );
    expect(fs.readlinkSync(lockOf(d))).to.equal(path.join(d, "gone"));
  });

  it("G07: on exit a holder removes its own lock only, never one that replaced it", async function () {
    const [mine, theirs] = dirs(2);
    const A = starter([mine]);
    const B = starter([theirs]);
    expect(await A.done).to.deep.equal([`0 HELD ${A.p.pid}`]);
    expect(await B.done).to.deep.equal([`0 HELD ${B.p.pid}`]);
    // B's lock removed by hand and taken by a signer elsewhere with B's pid
    const other =
      JSON.stringify({
        pid: B.p.pid,
        ...HERE,
        start: startOf(B.p.pid!),
        host: "elsewhere",
      }) + "\n";
    fs.rmSync(lockOf(theirs));
    fs.writeFileSync(lockOf(theirs), other, { mode: 0o600 });
    await A.end();
    await B.end();
    expect(fs.existsSync(lockOf(mine)), "A released its own lock").to.equal(
      false,
    );
    expect(
      fs.readFileSync(lockOf(theirs), "utf8"),
      "B left the other's lock",
    ).to.equal(other);
  });
});
