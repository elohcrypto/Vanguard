const { ethers } = require('hardhat');

/**
 * Sign a shipment proof for a specific escrow wallet.
 *
 * The signature is bound to the escrow address, the chain id and the data.
 * Signing the bare dataHash is no longer accepted on-chain: an unscoped
 * signature was replayable across escrows and across chains.
 *
 * @param {object} signer        ethers signer for the payee
 * @param {string} walletAddress escrow wallet the proof belongs to
 * @param {string} dataHash      keccak256 of the proof payload
 * @returns {Promise<string>} the signature to pass to submitShipmentProof
 */
async function signShipmentProof(signer, walletAddress, dataHash) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'address', 'uint256', 'bytes32'],
      ['VanguardShipmentProof', walletAddress, chainId, dataHash]
    )
  );
  return signer.signMessage(ethers.getBytes(digest));
}

module.exports = { signShipmentProof };
