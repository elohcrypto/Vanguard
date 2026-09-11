/**
 * Print the 12 role wallets derived from MNEMONIC (or generate a fresh
 * phrase if none is set), with each role's ETH balance on the target network.
 * Usage: npx hardhat run scripts/print-role-wallets.js --network <hardhat|localhost|sepolia>
 */
const { ethers, network } = require("hardhat");
const ROLES = [
  "platform owner / deployer", "fee wallet / compliance officer", "KYC issuer", "AML issuer",
  "risk oracle", "fraud oracle", "investor Alice", "investor Bob", "investor Carol",
  "unverified user", "spare", "spare",
];
async function main() {
  let phrase = process.env.MNEMONIC;
  if (!phrase) {
    phrase = ethers.Mnemonic.fromEntropy(ethers.randomBytes(16)).phrase;
    console.log("No MNEMONIC in env. Generated a fresh one (put it in .env, keep it private):\n");
    console.log(`  MNEMONIC="${phrase}"\n`);
  }
  console.log(`Network: ${network.name}\n`);
  console.log("idx  role                               address                                     balance");
  for (let i = 0; i < 12; i++) {
    const w = ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`);
    const bal = await ethers.provider.getBalance(w.address);
    console.log(`${String(i).padStart(3)}  ${ROLES[i].padEnd(34)} ${w.address}  ${ethers.formatEther(bal)} ETH`);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
