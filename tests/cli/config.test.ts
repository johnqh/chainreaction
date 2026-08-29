import { test, expect } from "bun:test";
import { loadConfig } from "../../src/cli/config";

const BASE_ENV: Record<string, string | undefined> = {
  CR_APP_ID: "12345",
  CR_PRIVATE_KEY_PATH: "/fake/app.pem",
  CR_INSTALLATION_ID: "987",
  CR_SCOPE: "@acme/",
  CR_REQUIRED_CHECKS: "ci",
};

const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
const readFile = () => FAKE_KEY;

test("a valid environment produces the expected config object", () => {
  const config = loadConfig(BASE_ENV, readFile);
  expect(config).toEqual({
    appId: "12345",
    privateKeyPem: FAKE_KEY,
    installationId: 987,
    scope: "@acme/",
    requiredChecks: ["ci"],
  });
});

for (const name of ["CR_APP_ID", "CR_PRIVATE_KEY_PATH", "CR_INSTALLATION_ID", "CR_SCOPE", "CR_REQUIRED_CHECKS"]) {
  test(`missing ${name} produces an error naming it`, () => {
    const env = { ...BASE_ENV };
    delete env[name];
    expect(() => loadConfig(env, readFile)).toThrow(new RegExp(name));
  });

  test(`blank ${name} (whitespace only) is treated as missing`, () => {
    const env = { ...BASE_ENV, [name]: "   " };
    expect(() => loadConfig(env, readFile)).toThrow(new RegExp(name));
  });
}

test("a non-numeric CR_INSTALLATION_ID is rejected, not coerced to NaN", () => {
  const env = { ...BASE_ENV, CR_INSTALLATION_ID: "not-a-number" };
  expect(() => loadConfig(env, readFile)).toThrow(/CR_INSTALLATION_ID/);
});

test("a zero CR_INSTALLATION_ID is rejected", () => {
  expect(() => loadConfig({ ...BASE_ENV, CR_INSTALLATION_ID: "0" }, readFile)).toThrow(
    /CR_INSTALLATION_ID/,
  );
});

test("a negative CR_INSTALLATION_ID is rejected", () => {
  expect(() => loadConfig({ ...BASE_ENV, CR_INSTALLATION_ID: "-5" }, readFile)).toThrow(
    /CR_INSTALLATION_ID/,
  );
});

test("a decimal CR_INSTALLATION_ID is rejected", () => {
  expect(() => loadConfig({ ...BASE_ENV, CR_INSTALLATION_ID: "12.5" }, readFile)).toThrow(
    /CR_INSTALLATION_ID/,
  );
});

test("CR_REQUIRED_CHECKS splits on commas and trims each entry", () => {
  const env = { ...BASE_ENV, CR_REQUIRED_CHECKS: " ci , build ,  " };
  const config = loadConfig(env, readFile);
  expect(config.requiredChecks).toEqual(["ci", "build"]);
});

test("CR_REQUIRED_CHECKS absent is a config error naming it — there is no default", () => {
  // `chainreaction-validate` (the pre-flight check) is never a valid default:
  // it only runs via workflow_dispatch and can never attach to a pull
  // request's head commit, so silently defaulting to it would set a required
  // status check that never appears and make every PR unmergeable. The only
  // correct value is the repo's own CI check, which only the operator knows.
  const env = { ...BASE_ENV };
  delete env["CR_REQUIRED_CHECKS"];
  expect(() => loadConfig(env, readFile)).toThrow(/CR_REQUIRED_CHECKS/);
});

test("CR_REQUIRED_CHECKS that filters down to nothing is a config error, not an empty list", () => {
  // ",,," is non-blank (passes the "is it set at all" check) but splits and
  // trims down to zero usable entries — the same shape of bug parseTargets
  // already guards against for --targets. Falling through to [] here would
  // make a typo in the environment look, to prepare/plan, exactly like every
  // repo missing its required status check.
  const env = { ...BASE_ENV, CR_REQUIRED_CHECKS: ",,," };
  expect(() => loadConfig(env, readFile)).toThrow(/CR_REQUIRED_CHECKS/);
});

test("CR_REQUIRED_CHECKS of only whitespace-separated commas is also a config error", () => {
  const env = { ...BASE_ENV, CR_REQUIRED_CHECKS: " , , " };
  expect(() => loadConfig(env, readFile)).toThrow(/CR_REQUIRED_CHECKS/);
});

test("an absent CR_REQUIRED_CHECKS and a malformed one are both config errors naming the variable", () => {
  // Neither collapses to a default or to an empty list: both are configuration
  // mistakes the operator must fix, and both errors must say which variable.
  const env = { ...BASE_ENV };
  delete env["CR_REQUIRED_CHECKS"];
  expect(() => loadConfig(env, readFile)).toThrow(/CR_REQUIRED_CHECKS/);
  expect(() => loadConfig({ ...BASE_ENV, CR_REQUIRED_CHECKS: ",,," }, readFile)).toThrow(
    /CR_REQUIRED_CHECKS/,
  );
});

test("a private key that cannot be read reports the path, and the error contains no key material", () => {
  const secretMarker = "SUPER-SECRET-KEY-BYTES";
  const throwingReadFile = () => {
    // A realistic fs error: it names the path, never file content.
    throw new Error("ENOENT: no such file or directory, open '/fake/app.pem'");
  };
  let message = "";
  try {
    loadConfig(BASE_ENV, throwingReadFile);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("/fake/app.pem");
  expect(message).not.toContain(secretMarker);
  expect(message).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
});
