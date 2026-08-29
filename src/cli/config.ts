import { readFileSync } from "node:fs";
import { DEFAULT_REQUIRED_CHECK } from "../prepare/probe";

export type Env = Record<string, string | undefined>;

/** Reads a file's contents as a string. Overridden in tests to avoid real disk access. */
export type FileReader = (path: string) => string;

export interface CliConfig {
  appId: string;
  privateKeyPem: string;
  installationId: number;
  scope: string;
  requiredChecks: string[];
}

function required(env: Env, name: string, hint: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required — set it to ${hint}.`);
  }
  return value;
}

/**
 * Reads and validates the environment ChainReaction's CLI needs to talk to a
 * real GitHub App installation. Pure aside from the injected `readFile`, so
 * every failure mode — a missing variable, a malformed one, an unreadable
 * key file — is testable without touching the real filesystem or network.
 *
 * The private key's contents never appear in a thrown message: a read
 * failure is reported by path only, never by whatever `readFile` raised.
 */
export function loadConfig(
  env: Env,
  readFile: FileReader = (path) => readFileSync(path, "utf8"),
): CliConfig {
  const appId = required(env, "CR_APP_ID", "the GitHub App's numeric ID");
  const privateKeyPath = required(
    env,
    "CR_PRIVATE_KEY_PATH",
    "the filesystem path to the GitHub App's private key (.pem)",
  );
  const installationIdRaw = required(
    env,
    "CR_INSTALLATION_ID",
    "the numeric ID of the GitHub App installation to act on",
  );
  const scope = required(
    env,
    "CR_SCOPE",
    'the npm package scope this installation manages, e.g. "@acme/"',
  );

  const trimmedInstallationId = installationIdRaw.trim();
  if (!/^[1-9]\d*$/.test(trimmedInstallationId)) {
    // Reject outright rather than passing Number(installationIdRaw) — which
    // is NaN for "abc" — downstream to TokenStore/InstallationGitHubApi,
    // where it would surface as an inscrutable failed HTTP request instead
    // of this actionable message.
    throw new Error(
      `CR_INSTALLATION_ID must be a positive integer — got ${JSON.stringify(installationIdRaw)}.`,
    );
  }
  const installationId = Number(trimmedInstallationId);

  const requiredChecksRaw = env["CR_REQUIRED_CHECKS"];
  let requiredChecks: string[];
  if (requiredChecksRaw === undefined || requiredChecksRaw.trim().length === 0) {
    requiredChecks = [DEFAULT_REQUIRED_CHECK];
  } else {
    requiredChecks = requiredChecksRaw
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (requiredChecks.length === 0) {
      // A non-blank value that filters down to nothing (",,," and similar) is
      // a typo, not "no override given" — the same distinction parseTargets
      // already draws for --targets in cli/main.ts. Letting it fall through
      // to an empty list would silently turn a malformed env var into "no
      // required status check" on every repo, which reads as a problem with
      // the customer's repos rather than with this variable.
      throw new Error(
        `CR_REQUIRED_CHECKS must be a comma-separated list of check names — got ${JSON.stringify(requiredChecksRaw)}.`,
      );
    }
  }

  let privateKeyPem: string;
  try {
    privateKeyPem = readFile(privateKeyPath);
  } catch {
    // Never interpolate the caught error into this message — on some
    // platforms a read failure can echo back partial file content, and the
    // private key must never appear in any error, log line, or output.
    // Reporting the path is always safe and always actionable.
    throw new Error(`CR_PRIVATE_KEY_PATH: could not read a private key at ${privateKeyPath}.`);
  }

  return { appId, privateKeyPem, installationId, scope, requiredChecks };
}
