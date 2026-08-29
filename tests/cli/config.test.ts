import { test, expect } from "bun:test";
import { loadConfig } from "../../src/cli/config";
import { DEFAULT_REQUIRED_CHECK } from "../../src/prepare/probe";

const BASE_ENV: Record<string, string | undefined> = {
  CR_APP_ID: "12345",
  CR_PRIVATE_KEY_PATH: "/fake/app.pem",
  CR_INSTALLATION_ID: "987",
  CR_SCOPE: "@acme/",
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
    requiredChecks: [DEFAULT_REQUIRED_CHECK],
  });
});

for (const name of ["CR_APP_ID", "CR_PRIVATE_KEY_PATH", "CR_INSTALLATION_ID", "CR_SCOPE"]) {
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

test("CR_REQUIRED_CHECKS absent defaults to [DEFAULT_REQUIRED_CHECK]", () => {
  const config = loadConfig(BASE_ENV, readFile);
  expect(config.requiredChecks).toEqual([DEFAULT_REQUIRED_CHECK]);
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

test("an absent CR_REQUIRED_CHECKS and a malformed one remain distinguishable outcomes", () => {
  // Absent -> the documented default. Malformed -> a thrown config error.
  // These must never collapse to the same "empty list" result.
  const absent = loadConfig(BASE_ENV, readFile);
  expect(absent.requiredChecks).toEqual([DEFAULT_REQUIRED_CHECK]);
  expect(() => loadConfig({ ...BASE_ENV, CR_REQUIRED_CHECKS: ",,," }, readFile)).toThrow();
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
