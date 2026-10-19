/**
 * Plan v2 Task 5.7: the record entries' labels (deployRecord.ts), read
 * from the compiled artifacts. Moved out of deployRecord.ts unchanged
 * (Task 5.17, the 500-line rule).
 */
import { artifacts, ethers } from "hardhat";

let names: { bytecode: string; name: string }[] | null = null;
let selectors: Map<string, string> | null = null;

/** The artifact whose creation code `data` starts with, else "create". */
export async function createLabel(data: string): Promise<string> {
  if (!names) {
    names = [];
    for (const fq of await artifacts.getAllFullyQualifiedNames()) {
      const a = await artifacts.readArtifact(fq);
      if (a.bytecode.length > 2) {
        names.push({
          bytecode: a.bytecode.toLowerCase(),
          name: a.contractName,
        });
      }
    }
    names.sort((x, y) => y.bytecode.length - x.bytecode.length);
  }
  const d = data.toLowerCase();
  return `new ${names.find((n) => d.startsWith(n.bytecode))?.name ?? "contract"}`;
}

/** `to`.fn for a call, fn read from the compiled ABIs by selector. */
export async function callLabel(to: string, data: string): Promise<string> {
  if (!selectors) {
    selectors = new Map();
    for (const fq of await artifacts.getAllFullyQualifiedNames()) {
      const i = new ethers.Interface((await artifacts.readArtifact(fq)).abi);
      i.forEachFunction((f) => selectors!.set(f.selector, f.name));
    }
  }
  return `${ethers.getAddress(to).slice(0, 10)}….${selectors.get(data.slice(0, 10)) ?? data.slice(0, 10)}`;
}
