/**
 * Print the 12 role wallets derived from MNEMONIC with each one's ETH
 * balance on the target network, labelled with the role the production
 * deploy gives that wallet by default (scripts/production/deployConfig.ts
 * INDEX; review D-5). Without MNEMONIC a fresh phrase is generated and
 * written to a new 0600 file (MNEMONIC_FILE, default .env.mnemonic.local,
 * gitignored), never to the terminal; an existing file is not overwritten.
 * Usage: npx hardhat run scripts/print-role-wallets.js --network <hardhat|localhost|sepolia>
 */
const fs = require("fs");
const { ethers, network } = require("hardhat");
const { INDEX } = require("./production/deployConfig");

const NAMES = {
  oracleNodes: "oracle node",
  proposer: "proposer",
  voters: "voter",
  escrowFeeWallet: "escrow fee wallet",
  issuerAdmin: "issuer admin",
  ops: "ops",
  guardian: "guardian",
};
const ROLES = Array.from({ length: 12 }, (_, i) =>
  i === 0 ? "deployer" : "no default role",
);
for (const [k, ix] of Object.entries(INDEX))
  for (const i of [ix].flat()) ROLES[i] = NAMES[k] ?? k;

/** A fresh phrase in a new 0600 file at `file`. */
function freshPhrase(file) {
  const phrase = ethers.Mnemonic.fromEntropy(ethers.randomBytes(16)).phrase;
  let fd;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    throw new Error(
      `${file} exists: not overwritten (put its phrase in .env as MNEMONIC, or set MNEMONIC_FILE to a new path)`,
    );
  }
  try {
    fs.writeSync(fd, `MNEMONIC="${phrase}"\n`);
  } finally {
    fs.closeSync(fd);
  }
  return phrase;
}

async function main() {
  let phrase = process.env.MNEMONIC;
  if (!phrase) {
    const file = process.env.MNEMONIC_FILE || ".env.mnemonic.local";
    phrase = freshPhrase(file);
    console.log(
      `No MNEMONIC in env. Wrote a fresh phrase to ${file} (0600): put it in .env as MNEMONIC and keep it private.\n`,
    );
  }
  console.log(`Network: ${network.name}\n`);
  console.log(
    "idx  role                               address                                     balance",
  );
  for (let i = 0; i < 12; i++) {
    const w = ethers.HDNodeWallet.fromPhrase(
      phrase,
      undefined,
      `m/44'/60'/0'/0/${i}`,
    );
    const bal = await ethers.provider.getBalance(w.address);
    console.log(
      `${String(i).padStart(3)}  ${ROLES[i].padEnd(34)} ${w.address}  ${ethers.formatEther(bal)} ETH`,
    );
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
