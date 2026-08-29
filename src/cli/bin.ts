#!/usr/bin/env bun
import { runCli, type CliDeps } from "./main";

const notWired = (what: string) => async (): Promise<never> => {
  throw new Error(`chainreaction: ${what} has no real backend wired up yet`);
};
const deps: CliDeps = { log: console.log, prepare: notWired("prepare"), plan: notWired("plan") };
process.exit(await runCli(process.argv.slice(2), deps));
