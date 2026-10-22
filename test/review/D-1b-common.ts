// Shared by the D-1b tests (round 2 of review D-1): nested role Safes,
// a phase run with its output captured, and the guardian handed to a
// Safe after the ceremony (governance impersonated, as a vote would).
import * as fs from "fs";
import { ethers, network } from "hardhat";
import { cliConfig } from "../helpers/handoverCli";
import { runHandover, preflightOnly } from "../../scripts/handover";
import { handoverArgs } from "../../scripts/handoverConfig";

const { externalRole } = require("../../demo/utils/RoleCalls");
const { auditHandover } = require("../../demo/utils/Handover");

/** `depth` TestMultisigs, the innermost owned by `owner`, under a guardian Safe R (owners [outermost, s15], 1 of 2). */
export async function nested(owner: string, depth: number) {
  const MS = await ethers.getContractFactory("TestMultisig");
  const s = await ethers.getSigners();
  const safes: any[] = [];
  let o = owner;
  for (let i = 0; i < depth; i++) {
    safes.push(await MS.deploy([o], 1));
    o = await safes[i].getAddress();
  }
  const R = await MS.deploy([o, s[15].address], 1);
  return { R, rAddr: await R.getAddress(), safes };
}

/** The phase's verdict ("ok" or the error) and every line it printed. */
export const phase = (cfg: any, name: string, cfgPath: string) =>
  captureRun(() => runHandover(cfg, name, cfgPath));

/** The ceremony's preflight (no send) with `guardian` read as an external role, past the config's vet. */
export async function preflightAs(cfg: any, cfgPath: string, guardian: string) {
  const { args } = await handoverArgs(cfg, "preflight", cfgPath);
  const g = { ...args, guardian: externalRole(guardian, "guardian") };
  return captureRun(() => preflightOnly(g));
}

/** The day-2 audit with `guardian` read as an external role, past the config's vet. */
export async function auditAs(cfg: any, cfgPath: string, guardian: string) {
  const { args } = await handoverArgs(cfg, "audit", cfgPath);
  const out: string[] = [];
  let verdict = "ok";
  await auditHandover(
    { ...args, guardian: externalRole(guardian, "guardian") },
    (m: string) => out.push(m),
  ).catch((e: any) => (verdict = e.message));
  return { verdict, out };
}

async function captureRun(fn: () => Promise<void>) {
  const quiet = console.log;
  const out: string[] = [];
  console.log = (...m: any[]) => out.push(m.join(" "));
  let verdict = "ok";
  try {
    await fn().catch((e: any) => (verdict = e.message));
  } finally {
    console.log = quiet;
  }
  return { verdict, out };
}

/** Governance names `guardian` on VSC (impersonated, as its vote would). */
export async function governanceSetsGuardian(f: any, guardian: string) {
  await network.provider.send("hardhat_impersonateAccount", [f.govAddr]);
  await network.provider.send("hardhat_setBalance", [
    f.govAddr,
    "0x56BC75E2D63100000",
  ]);
  const gov = await ethers.getSigner(f.govAddr);
  await (await f.c.token.connect(gov).setGuardian(guardian)).wait();
  await network.provider.send("hardhat_stopImpersonatingAccount", [f.govAddr]);
}

/** The honest ceremony (guardian a key), then governance names `guardian` on VSC. */
export async function ceremonyThenGuardian(f: any, guardian: string) {
  const { cfg, cfgPath, dir } = await cliConfig(f);
  const full = await phase(cfg, "full", cfgPath);
  if (full.verdict !== "ok")
    throw new Error(`honest ceremony: ${full.verdict}`);
  await governanceSetsGuardian(f, guardian);
  return {
    cfg,
    cfgPath,
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** `calls` as TestMultisig `m` runs them (one owner approves, then executes), for the owner above `m` to send. */
export async function through(m: any, calls: any[]) {
  const to = await m.getAddress();
  return [
    {
      to,
      value: 0,
      data: m.interface.encodeFunctionData("approve", [await m.hashOf(calls)]),
    },
    { to, value: 0, data: m.interface.encodeFunctionData("execute", [calls]) },
  ];
}
