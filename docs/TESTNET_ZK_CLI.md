# ZK command lines: whitelist roots, proofs and attestations

The testnet guide is four files: [setup](TESTNET_SETUP.md) (roles, time scale, governance rules, rehearsal, Sepolia, gas), [demo options](TESTNET_DEMO_OPTIONS.md) (privacy, custody, oracles, identity keys), [ceremony](TESTNET_CEREMONY.md) (the handover and the operators' rules) and [ZK command lines](TESTNET_ZK_CLI.md) (whitelist roots, proofs, attestations). The ordered operator procedure is the [runbook](OPERATOR_RUNBOOK.md).

Every CLI here reads its RPC URL from `ZK_RPC_URL_FILE` (a 0600 file) or
`ZK_RPC_URL`, never argv (`--rpc` is refused), and each key from
`<NAME>_FILE` (0600) or `<NAME>`: `WHITELIST_OPS_KEY`,
`WHITELIST_WALLET_KEY`, `ATTESTOR_KEY`. A published Hardhat test key is
refused on any chain but 31337. Prefer the file forms: an inline
`NAME=<value>` prefix lands in the shell history.

## Whitelist roots and proofs from the command line (Task 3.5)

The investor keeps a secret and hands the operator only the commitment
`Poseidon(identity, secret)`, where the identity is the investor's
OnchainID address. The secret is read from a file or `WHITELIST_SECRET`,
never from the command line, and is never printed. Generate it with
`--new-secret`: a secret below 2^128 is refused, because the leaves and the
OnchainID addresses are public, so a small secret can be recovered by
trying values, and whoever recovers it binds their own wallet first.

```bash
# Investor, once: a fresh secret (31 random bytes) in a new file with mode
# 0600 (an existing file is refused); keep the file offline
node scripts/zk/prove-whitelist.js --new-secret --out secret.txt

# Investor, at onboarding: the commitment to hand the operator
node scripts/zk/prove-whitelist.js --commitment --identity <onchainID> --secret-file secret.txt

# Operator (ops, the listOperator): entries.json is
# [{ "identity": "<onchainID>", "commitment": "<0x..>" }, ...], one per identity
ZK_RPC_URL_FILE=<0600 file> WHITELIST_OPS_KEY_FILE=<0600 file> node scripts/zk/build-whitelist-root.js \
  --in entries.json --out root.json --publish --privacy-manager <addr>

# Investor, with the published root.json: prove, bind the wallet, show the status
ZK_RPC_URL_FILE=<0600 file> WHITELIST_WALLET_KEY_FILE=<0600 file> node scripts/zk/prove-whitelist.js \
  --root root.json --identity <onchainID> --wallet <wallet> --secret-file secret.txt \
  --out proof.json --submit --privacy-manager <addr>  # the URL: a 0600 file, never argv
```

Leaf order is the order of `entries.json`, so the same file always gives
the same root. Without `--submit` the prover prints the calldata
`{ proof, signals }` for `submitWhitelistProof` and refuses a commitment
that is not in `root.json`. With `--submit` it also refuses a root that is
not the current published one: when nothing is published yet it prints the
publish command for ops; when ops has published a newer root it asks for
the current `root.json` and a new proof (an old root is never
republished, which would lapse every binding under the current one).
The builder enforces the operator's side of that rule: `--publish` reads
every `WhitelistRootPublished` of the root from block 0 (or
`--from-block <n>`) and refuses a root that was ever published before
unless `--force`, because an old root, rebuilt for instance from an old
`entries.json` backup, re-admits investors removed since. When the
`--out` file exists, it first prints how many commitments the new build
adds and removes against it. The prover warns on stderr when
`--secret-file` is readable by group or others, and when `--new-secret`
writes to stdout instead of `--out`.
Demo option 42 -> 1 builds roots and proofs with the same functions. Its
first publish calls `publishWhitelistRoot` directly, with no old-root
history check; the rotations in steps (d) and (e) publish through the
CLI's `publishRoot`, which refuses a root that was published before.

## Issuer-signed attestations (Task 3.7b, D31 a)

The jurisdiction, accreditation and compliance-aggregation proofs show
that a trusted issuer signed the investor's attributes and that they meet
PrivacyManager's policy, without revealing them. The issuer holds an EdDSA
Baby Jubjub key; PrivacyManager trusts its public key (Ax, Ay) per circuit
(`setTrustedAttestor`) and holds the policy: the allowed jurisdiction mask
(below), `minimumAccreditation`, and the compliance minimum with four
weights summing to 100 (`setCompliancePolicy`). A proof records
{policyHash, attestor, nullifier, expiresAt} for the wallet that submits
it, one wallet per attestation per policy; a policy change, an untrusted
issuer key or expiry lapses it, and a policy change (a ComplianceRules
rule change for VSC included) re-admits the same attestation for a new
proof, from any wallet. Like a whitelist root version, every policy change
(a policy token or code registration, either policy setter) and every
trust change of a key starts a new epoch: restoring a policy or
re-trusting a key never revives an old record, holders resubmit.

An attestation is per chain and per PrivacyManager (Task 3.8 review M1):
the issuer signs the chain id and the PrivacyManager address with the
attributes, PrivacyManager refuses a proof naming another chain or
another PrivacyManager, and the prover refuses before proving. An issuer
key trusted on two deployments therefore cannot carry an attestation from
one to the other, where the same bit may mean another country; after a
redeploy, issuers sign again for the new PrivacyManager.

An attestation also expires on a date the issuer sets (Task 3.10, D32 a):
`attest.js --sign` requires `--valid-days <n>` or `--valid-until <ISO 8601
UTC date>` (`2027-01-01`, or a UTC time ending in `Z` such as
`2027-01-01T00:00:00Z`; a time without `Z` or with an offset is refused) and refuses a date not in the future; the issuer signs that
`validUntil` with the attributes and the proof publishes it. PrivacyManager
refuses the proof from `validUntil` on (`AttestationExpired`), and a
record's `expiresAt` is `min(submission + proofValidityPeriod,
validUntil)`, so a record never outlives its attestation and the same
calldata cannot be resubmitted after it: a lapsed accreditation or a
dropped score needs a new attestation, which renews the record. The
prover refuses an expired attestation before proving, naming the date.

The jurisdiction set for private proofs is ComplianceRules' rule for VSC
(Task 3.8): the one transfers enforce, with no second list to keep in
step. PrivacyManager names the token with `setPolicyToken(VSC)` and reads
its ComplianceRules from `VSC.compliance()` on every use, so a Token vote
moving VSC to a new ComplianceRules moves the private path with it; it
keeps only the code-to-bit table issuers attest: each ISO 3166-1
numeric code gets the next of 64 bits with `registerJurisdictionCode`, and
a bit never moves. The allowed mask is the OR of the bits of the
registered codes that `ComplianceRules.validateJurisdiction(VSC, code)`
admits (the default blocked list, then VSC's own rule). Blocking a country
in ComplianceRules (a ComplianceRules vote after the handover) is enough
to stop its holders on the private path; every `setJurisdictionRule` or
`clearJurisdictionRule` for VSC bumps `jurisdictionRuleVersion(VSC)`,
which is part of the policy, so it lapses every jurisdiction record
whatever the holder's country, and restoring the rule revives none. A
code without a bit cannot be attested until it is registered. Option 21
points PrivacyManager at VSC's rule and registers its allow list in order
(840 is bit 1), printing the bits; the ceremony refuses a PrivacyManager
whose policy token is not VSC. A code added to VSC's allow list later
(the jurisdiction-list menu, or a ComplianceRules vote) gets no bit by
itself: rerun option 21 or 41 before the handover, or pass a
PrivacyParameters vote for `registerJurisdictionCode` after it, before
investors from that country can attest. Today a Token round trip back to
an earlier ComplianceRules whose rule did not change (R1 -> R2 -> R1)
revives the records made under it. Task 4.1 does not change that:
ComplianceRules never sees a `Token.setCompliance`, so the fix belongs to
PrivacyManager (a test pins the current behaviour). Task 4.1, the
ComplianceRules split, is fresh-deploy only (D34 a): governance binds its
ComplianceRules at construction, so an existing deployment is redeployed
rather than migrated, and a fresh ComplianceRules starts OracleOnly with
no oracle, an open whitelist, until it is configured.

```bash
# Issuer, once: the private key is printed once; keep it offline
node scripts/zk/attest.js --new-key
# Issuer: the public key for the setTrustedAttestor vote, then sign
ATTESTOR_KEY_FILE=<0600 file> node scripts/zk/attest.js --public-key
ZK_RPC_URL_FILE=<0600 file> ATTESTOR_KEY_FILE=<0600 file> node scripts/zk/attest.js --sign --circuit jurisdiction \
  --identity <onchainID> --country <ISO numeric> \
  --privacy-manager <addr> --valid-days 365 --out att.json
#   or --valid-until 2027-01-01 (ISO 8601 UTC); the expiry is required
#   offline: --chain-id <id> --privacy-manager <addr> --mask <its bit>
#   ... --circuit accreditation --amount <amount>
#   ... --circuit compliance --scores <kyc,aml,jurisdiction,accreditation>
# Investor: policy and issuer trust read from PrivacyManager
ZK_RPC_URL_FILE=<0600 file> WHITELIST_WALLET_KEY_FILE=<0600 file> node scripts/zk/prove-attestation.js \
  --attestation att.json --wallet <wallet> \
  --privacy-manager <addr> --out proof.json --submit
```

The issuer key comes from `ATTESTOR_KEY_FILE` (0600) or `ATTESTOR_KEY` only, never argv, and is printed
only by `--new-key`. The attestation file carries the salt and the
signature: it is the investor's secret, written with mode 0600, and the
prover never prints either. The prover refuses an untrusted issuer key, an
expired attestation, a stale policy and attributes that miss the policy
before proving, verifies
the proof locally, and with `--submit` exits non-zero unless the record
reads valid. Before the handover the owner calls the setters; after it a
PrivacyParameters vote (type 11) does: trust the issuer's key for each
circuit it vouches for, untrust the demo key, and set
`setMinimumAccreditation` / `setCompliancePolicy`, and give new codes a
bit (`registerJurisdictionCode`); which codes are allowed is VSC's
ComplianceRules rule.
