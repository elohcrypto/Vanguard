const { expect } = require("chai");
const { MerkleTreeBuilder } = require("../../utils/merkle-tree-builder");

/**
 * The builder is SPARSE: a 20-level tree holds 2^20 leaf slots but only the
 * populated prefix is hashed; every empty subtree is one precomputed hash per
 * height. It used to materialise all 2^20 slots (1,048,575 Poseidon calls,
 * ~37s locally, over the CI timeout) to hold four leaves.
 *
 * The dense reference below is the previous implementation, kept here as the
 * oracle: root, every proof, and leaf indices must be identical.
 */
function denseBuild(builder, leaves) {
  const levels = builder.levels;
  const tree = [[...leaves]];
  while (tree[0].length < 2 ** levels) tree[0].push(0n);
  for (let l = 0; l < levels; l++) {
    const next = [];
    for (let i = 0; i < tree[l].length; i += 2) {
      next.push(builder.hash(tree[l][i] ?? 0n, tree[l][i + 1] ?? 0n));
    }
    tree[l + 1] = next;
  }
  const proof = (idx) => {
    const pathElements = [], pathIndices = [];
    for (let l = 0; l < levels; l++) {
      const left = idx % 2 === 0;
      pathElements.push(tree[l][left ? idx + 1 : idx - 1] ?? 0n);
      pathIndices.push(left ? 0 : 1);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  };
  return { root: tree[levels][0], proof };
}

describe("MerkleTreeBuilder (sparse)", function () {
  this.timeout(60000);

  for (const [levels, n] of [[4, 1], [4, 3], [4, 16], [8, 37], [10, 100]]) {
    it(`matches the dense reference at ${levels} levels, ${n} leaves`, async () => {
      const ids = Array.from({ length: n }, (_, i) => BigInt(i * 7919 + 13));
      const s = await MerkleTreeBuilder.createFromIdentities(ids, levels);
      const d = denseBuild(s, ids.map((id) => s.hashSingle(id)));
      expect(s.getRoot()).to.equal(d.root);
      for (let i = 0; i < n; i++) {
        const ps = s.getProof(i), pd = d.proof(i);
        expect(ps.pathElements).to.deep.equal(pd.pathElements);
        expect(ps.pathIndices).to.deep.equal(pd.pathIndices);
        expect(s.verifyProof(s.hashSingle(ids[i]), s.getRoot(), ps.pathElements, ps.pathIndices)).to.equal(true);
      }
      expect(s.findLeafIndex(s.hashSingle(ids[n - 1]))).to.equal(n - 1);
      expect(s.findLeafIndex(424242n)).to.equal(-1);
    });
  }

  it("empty tree matches the dense reference (blacklist non-membership path)", async () => {
    const s = await MerkleTreeBuilder.createEmptyTree(8);
    const d = denseBuild(s, [0n]);
    expect(s.getRoot()).to.equal(d.root);
    expect(s.getProof(0).pathElements).to.deep.equal(d.proof(0).pathElements);
  });

  it("builds a 20-level tree in well under a second", async () => {
    // The dense build took ~37s here and timed out on CI. Generous bound so a
    // slow runner passes; a regression to dense would be two orders over it.
    const t = Date.now();
    const s = await MerkleTreeBuilder.createFromIdentities([11111n, 12345n, 33333n, 44444n]);
    expect(Date.now() - t).to.be.below(5000);
    expect(s.getStats().levels).to.equal(20);
    expect(s.getStats().maxLeaves).to.equal(2 ** 20);
    expect(s.getProof(1).pathElements).to.have.lengthOf(20);
  });

  it("rejects more leaves than the tree can hold", async () => {
    const b = new MerkleTreeBuilder(2);
    await b.initialize();
    expect(() => b.buildTree([1n, 2n, 3n, 4n, 5n])).to.throw("Too many leaves");
  });
});
