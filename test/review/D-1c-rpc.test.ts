// D-1c (round 3, A4): the Safe reader swallows only "no such function",
// a revert with no data or a call answering no data, as each provider
// reports it; every other error (an HTTP or JSON-RPC failure, a timeout,
// a rate limit, a node fault whose text says "reverted", out of gas)
// fails the run. The attack lane's 40 cases: five reads times eight
// error classes, each thrown on a deployer-held guardian Safe.
import { expect } from "chai";
import { ethers } from "hardhat";
import { handoverFixture } from "../helpers/governanceFixture";
import * as c from "./D-1c-common";

const kinds: [string, () => any][] = [
  [
    "SERVER_ERROR 502",
    () =>
      ethers.makeError("bad gateway", "SERVER_ERROR", {
        request: {} as any,
        response: { statusCode: 502 } as any,
      }),
  ],
  [
    "429 rate limit (SERVER_ERROR)",
    () =>
      ethers.makeError("Too Many Requests", "SERVER_ERROR", {
        request: {} as any,
        response: { statusCode: 429 } as any,
      }),
  ],
  [
    "NETWORK_ERROR",
    () =>
      ethers.makeError("network down", "NETWORK_ERROR", { event: "x" } as any),
  ],
  [
    "UNKNOWN_ERROR rate limit json-rpc",
    () =>
      ethers.makeError("could not coalesce error", "UNKNOWN_ERROR", {
        error: { code: -32005, message: "rate limit exceeded" },
      } as any),
  ],
  [
    "TIMEOUT",
    () => ethers.makeError("timeout", "TIMEOUT", { operation: "x" } as any),
  ],
  ["plain Error ETIMEDOUT", () => new Error("request timeout (ETIMEDOUT)")],
  [
    "UNKNOWN_ERROR whose text says reverted",
    () =>
      ethers.makeError(
        "upstream said: execution reverted: header not found (pruned state)",
        "UNKNOWN_ERROR",
        {
          error: {
            code: -32000,
            message: "execution reverted: missing trie node",
          },
        } as any,
      ),
  ],
  [
    "plain Error whose text says reverted",
    () => new Error("503 from reverse proxy: upstream reverted to cache"),
  ],
];

/** `fn` with `ethers.provider` calls to `to` (`sel` set) or its getCode faulted by `mk`. */
async function faulted(
  to: string,
  sel: string | null,
  mk: () => any,
  fn: () => Promise<any>,
) {
  const prov: any = ethers.provider;
  const [call, code] = [prov.call.bind(prov), prov.getCode.bind(prov)];
  let hits = 0;
  const hit = (a: any) => String(a).toLowerCase() === to.toLowerCase();
  prov.call = async (tx: any) => {
    if (sel && hit(tx.to) && String(tx.data).startsWith(sel)) {
      hits++;
      throw mk();
    }
    return call(tx);
  };
  prov.getCode = async (a: any, ...r: any[]) => {
    if (!sel && hit(a)) {
      hits++;
      throw mk();
    }
    return code(a, ...r);
  };
  try {
    return { r: await fn(), hits };
  } finally {
    prov.call = call;
    prov.getCode = code;
  }
}

describe("D-1c RPC errors in the role Safe reader", function () {
  this.timeout(900000);
  const targets = [
    "getOwners",
    "getThreshold",
    "getModulesPaginated",
    "getCode(top)",
    "getCode(nested owner)",
  ];
  for (const t of targets) {
    for (const [kn, mk] of kinds) {
      it(`${t} throwing ${kn} refuses a deployer-held guardian`, async function () {
        const f = await handoverFixture();
        const s = await ethers.getSigners();
        const d = f.deployer.address;
        const MS = await ethers.getContractFactory("TestMultisig");
        let R: any;
        let at = "";
        if (t === "getModulesPaginated") {
          R = await MS.deploy([s[15].address, s[16].address], 2);
          await (await R.setModule(d)).wait();
        } else if (t === "getCode(nested owner)") {
          const inner = await MS.deploy([d], 1);
          R = await MS.deploy([await inner.getAddress(), s[15].address], 1);
          at = await inner.getAddress();
        } else R = await MS.deploy([d, s[15].address], 1);
        const rAddr = await R.getAddress();
        at = at || rAddr;
        const sel = t.startsWith("getCode")
          ? null
          : R.interface.getFunction(t)!.selector;
        const { r, hits } = await faulted(at, sel, mk, () => c.vet(rAddr, d));
        console.log(
          `      [${t} | ${kn}] hits=${hits}: ${r.words.slice(0, 120)}`,
        );
        expect(hits).to.be.greaterThan(0);
        expect(r.words).to.not.equal("accepted");
      });
    }
  }

  // As the providers report "no such function" (measured: Hardhat in
  // process, a Hardhat node over HTTP, an EIP-1474 node's code 3), and
  // out of gas, which is no such answer.
  const shapes: [string, () => any, boolean][] = [
    [
      "a Hardhat node's revert with no data (-32603)",
      () =>
        Object.assign(
          new Error("Error: Transaction reverted without a reason string"),
          { code: -32603, data: { message: "reverted", data: "0x" } },
        ),
      true,
    ],
    [
      "an EIP-1474 node's revert with no data (code 3)",
      () =>
        Object.assign(new Error("execution reverted"), { code: 3, data: "0x" }),
      true,
    ],
    [
      "out of gas with no data (-32000)",
      () =>
        Object.assign(new Error("Transaction ran out of gas"), {
          code: -32000,
          data: { message: "Transaction ran out of gas", data: "0x" },
        }),
      false,
    ],
  ];
  for (const [kn, mk, none] of shapes) {
    it(`getOwners answering ${kn} ${none ? "reads as no Safe" : "fails the run"}`, async function () {
      const f = await handoverFixture();
      const d = f.deployer.address;
      const MS = await ethers.getContractFactory("TestMultisig");
      const R = await MS.deploy([d], 1);
      const rAddr = await R.getAddress();
      const sel = R.interface.getFunction("getOwners")!.selector;
      const { r, hits } = await faulted(rAddr, sel, mk, () => c.vet(rAddr, d));
      console.log(`      [${kn}] hits=${hits}: ${r.words.slice(0, 120)}`);
      expect(hits).to.be.greaterThan(0);
      if (none) {
        expect(r.words).to.equal("accepted");
        expect(r.logs.join("\n")).to.contain(
          `guardian ${rAddr} has code but no readable getOwners()`,
        );
      } else expect(r.words).to.contain("ran out of gas");
    });
  }
});
