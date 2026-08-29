import { createRoot } from "react-dom/client";
import { App } from "./App";
// TODO: scope is a per-installation value (see CliConfig.scope /
// GitHubGraphSource); the server does not yet expose it to the web UI
// (src/server/index.ts is owned by another in-flight task). Passing "" here
// keeps this entry point compiling and hardcode-free until that wiring
// lands — it only affects the cosmetic prefix-stripping in App's display.
createRoot(document.getElementById("root")!).render(<App scope="" />);
