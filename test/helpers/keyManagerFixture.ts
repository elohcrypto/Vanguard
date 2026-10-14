// The KeyManager suite's shared setup (Task 5.4 split KeyManager.test.ts
// into KeyManager{Rotation,MultiSig,Recovery,Integration}.test.ts): the key
// purposes and timelocks, and a KeyManager authorized and pinned as the
// recovery manager on one OnchainID with a manager key, deployed per test.
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { KeyManager, OnchainID } from "../../typechain-types";

// Key purposes
export const MANAGEMENT_KEY = 1;
export const ACTION_KEY = 2;
export const CLAIM_SIGNER_KEY = 3;
export const ENCRYPTION_KEY = 4;

// Key types
export const ECDSA_TYPE = 1;

// Time constants
export const DEFAULT_TIMELOCK = 24 * 60 * 60; // 24 hours
export const RECOVERY_TIMELOCK = 48 * 60 * 60; // 48 hours

export async function deployKeyManager() {
  let keyManager: KeyManager;
  let onchainID: OnchainID;
  let owner: SignerWithAddress;
  let identity: SignerWithAddress;
  let manager: SignerWithAddress;
  let recoveryAgent1: SignerWithAddress;
  let recoveryAgent2: SignerWithAddress;
  let recoveryAgent3: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  [
    owner,
    identity,
    manager,
    recoveryAgent1,
    recoveryAgent2,
    recoveryAgent3,
    unauthorized,
  ] = await ethers.getSigners();

  // Deploy KeyManager
  const KeyManagerFactory = await ethers.getContractFactory("KeyManager");
  keyManager = await KeyManagerFactory.deploy();
  await keyManager.waitForDeployment();

  // Deploy OnchainID for testing
  const OnchainIDFactory = await ethers.getContractFactory("OnchainID");
  onchainID = await OnchainIDFactory.deploy(identity.address);
  await onchainID.waitForDeployment();

  // Add manager key to OnchainID for testing
  const managerKey = ethers.keccak256(
    ethers.solidityPacked(["address"], [manager.address]),
  );
  await onchainID
    .connect(identity)
    .addKey(managerKey, MANAGEMENT_KEY, ECDSA_TYPE);

  // Authorize KeyManager to perform operations on OnchainID
  await onchainID
    .connect(identity)
    .authorizeManager(await keyManager.getAddress());
  // Task 4.11: recovery runs only through the pinned recovery manager.
  await onchainID
    .connect(identity)
    .pinRecoveryManager(await keyManager.getAddress());
  return {
    keyManager,
    onchainID,
    owner,
    identity,
    manager,
    recoveryAgent1,
    recoveryAgent2,
    recoveryAgent3,
    unauthorized,
  };
}
