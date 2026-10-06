/**
 * @fileoverview Demo option 19 (plan v2 Task 4.7 fix round, review L1):
 * ComplianceRules access control on VSC, each step counted from what the
 * chain did. A refusal passes only with the expected revert, and the
 * summary is the count. Refusals are eth_calls (nothing changes); the
 * owner's grant and revoke are transactions, and wallet 1's administrator
 * flag is restored to what it was before.
 */

const { displaySuccess, displayError } = require("./DisplayHelpers");

const NOT_ADMIN = "ComplianceRules: Only governance can update rules";
const NOT_OWNER = "OwnableUnauthorizedAccount";

/** Revert reason string or custom error name of `e`, else its message. */
function reasonOf(e, iface) {
  const data = [e.data, e.data?.data, e.error?.data, e.info?.error?.data].find(
    (d) => typeof d === "string" && d.length >= 10,
  );
  let p = null;
  try {
    p = data ? iface.parseError(data) : null;
  } catch {}
  if (p) return p.name === "Error" ? p.args[0] : p.name;
  return e.revert?.name ?? e.reason ?? e.message ?? "";
}

async function runAccessControlChecks(state, log = console.log) {
  const rules = state.getContract("complianceRules");
  const token = state.getContract("digitalToken");
  if (!rules || !token) {
    displayError("Option 19 needs ComplianceRules and VSC (options 13, 21)");
    return null;
  }
  const [owner, admin, user, other] = state.signers;
  const vsc = await token.getAddress();
  const iface = rules.interface;
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok });
    log(
      `   ${ok === true ? "✅" : ok === false ? "❌" : "⏭️ "} ${name}: ${detail}`,
    );
  };
  /** An eth_call that must revert with `want`. */
  const refused = async (name, call, want) => {
    try {
      await call();
      record(name, false, "accepted (expected a revert)");
    } catch (e) {
      const why = reasonOf(e, iface);
      record(
        name,
        why === want,
        `reverted "${why}"${why === want ? "" : `, expected "${want}"`}`,
      );
    }
  };
  const rule = [vsc, [840, 276, 826], [643, 156]];

  log(`\n🔐 ComplianceRules ${await rules.getAddress()}, VSC ${vsc}`);
  const ownsIt =
    (await rules.owner()).toLowerCase() === owner.address.toLowerCase();
  const wasAdmin = await rules.ruleAdministrators(vsc, admin.address);
  if (!ownsIt) {
    record(
      "owner grants an administrator",
      null,
      `ComplianceRules is owned by ${await rules.owner()} (governance after the handover): a ComplianceRules vote`,
    );
  } else {
    await (
      await rules.connect(owner).setRuleAdministrator(vsc, admin.address, true)
    ).wait();
    record(
      "owner grants wallet 1 rule administrator on VSC",
      await rules.ruleAdministrators(vsc, admin.address),
      "ruleAdministrators read back",
    );
  }
  if (await rules.ruleAdministrators(vsc, admin.address)) {
    try {
      await rules.connect(admin).setJurisdictionRule.staticCall(...rule);
      record(
        "administrator may set VSC's jurisdiction rule",
        true,
        "accepted (eth_call; the rule is left as it is)",
      );
    } catch (e) {
      record(
        "administrator may set VSC's jurisdiction rule",
        false,
        `reverted "${reasonOf(e, iface)}"`,
      );
    }
  } else
    record(
      "administrator may set VSC's jurisdiction rule",
      null,
      "wallet 1 is not an administrator",
    );
  await refused(
    "a non-administrator cannot set the rule",
    () => rules.connect(user).setJurisdictionRule.staticCall(vsc, [392], []),
    NOT_ADMIN,
  );
  await refused(
    "a non-owner cannot grant an administrator",
    () =>
      rules
        .connect(user)
        .setRuleAdministrator.staticCall(vsc, other.address, true),
    NOT_OWNER,
  );
  if (ownsIt) {
    await (
      await rules.connect(owner).setRuleAdministrator(vsc, admin.address, false)
    ).wait();
    record(
      "owner revokes wallet 1",
      !(await rules.ruleAdministrators(vsc, admin.address)),
      "ruleAdministrators read back",
    );
    await refused(
      "the revoked administrator cannot set the rule",
      () => rules.connect(admin).setJurisdictionRule.staticCall(...rule),
      NOT_ADMIN,
    );
    if (wasAdmin) {
      await (
        await rules
          .connect(owner)
          .setRuleAdministrator(vsc, admin.address, true)
      ).wait();
      log("   ↩️  wallet 1 was an administrator before: restored");
    }
  } else {
    record("owner revokes wallet 1", null, "not the owner");
    record(
      "the revoked administrator cannot set the rule",
      null,
      "nothing revoked",
    );
  }

  const passed = results.filter((r) => r.ok === true).length;
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.length - passed - failed;
  log(
    `\n📊 ${passed} passed, ${failed} failed, ${skipped} not run (of ${results.length})`,
  );
  if (failed) displayError(`${failed} ACCESS CONTROL CHECK(S) FAILED`);
  else if (skipped)
    log("   ℹ️  Some checks need the deployer as owner (before the handover)");
  else displaySuccess(`ALL ${passed} ACCESS CONTROL CHECKS HOLD ON CHAIN`);
  return { passed, failed, skipped, results };
}

module.exports = { runAccessControlChecks, reasonOf, NOT_ADMIN, NOT_OWNER };
