import { ethers } from "hardhat";

/**
 * Bind a fresh ConsensusOracle engine to `oracleManager` (plan v2 Task
 * 4.4: the manager opens no query without one). Returns the engine.
 */
export async function bindEngine(oracleManager: any): Promise<any> {
  const engine = await (
    await ethers.getContractFactory("ConsensusOracle")
  ).deploy(await oracleManager.getAddress());
  await (
    await oracleManager.setConsensusEngine(await engine.getAddress())
  ).wait();
  return engine;
}

/** OracleManager with a bound engine: { oracleManager, engine }. */
export async function deployOracleManager(): Promise<{
  oracleManager: any;
  engine: any;
}> {
  const oracleManager = await (
    await ethers.getContractFactory("OracleManager")
  ).deploy();
  const engine = await bindEngine(oracleManager);
  return { oracleManager, engine };
}
