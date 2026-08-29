#!/usr/bin/env bun
import { runCli } from "./main";
import { loadConfig } from "./config";
import { realDeps } from "./deps";

// The only file in this codebase that calls process.exit. Config loading and
// dependency construction happen before runCli, so an unguarded failure here
// would print a raw stack trace — the one thing the CLI otherwise avoids.
try {
  const config = loadConfig(process.env);
  process.exit(await runCli(process.argv.slice(2), realDeps(config)));
} catch (err) {
  console.error(`chainreaction: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
