#!/usr/bin/env bun
import { runCli, type CliDeps } from "./main";
import { loadConfig, loadOAuthConfig } from "./config";
import { realDeps, realServerDeps } from "./deps";
import { createServer } from "../server/index";

// The only file in this codebase that calls process.exit. Config loading and
// dependency construction happen before runCli, so an unguarded failure here
// would print a raw stack trace — the one thing the CLI otherwise avoids.
try {
  const config = loadConfig(process.env);
  const deps: CliDeps = {
    ...realDeps(config),
    // Deferred until "serve" is actually the command run: prepare/plan must
    // never require the OAuth env `loadOAuthConfig` checks for. Reuses the
    // same `config` `realDeps` above was built from — one load, not two
    // divergent readings of process.env.
    serve: async () => {
      const auth = loadOAuthConfig(process.env);
      createServer(realServerDeps(config, auth));
      // Bun.serve()'s own listener is what keeps this process alive; this
      // promise is deliberately never resolved so `process.exit` below is
      // never reached while the server is actually running — only a
      // construction failure above (thrown before createServer starts
      // anything) ever completes this call.
      return new Promise<number>(() => {});
    },
  };
  process.exit(await runCli(process.argv.slice(2), deps));
} catch (err) {
  console.error(`chainreaction: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
