// Registers a happy-dom global environment for bun test, so React components
// can be rendered and interacted with in tests. Loaded via bunfig.toml
// [test] preload — see https://bun.sh/docs/test/dom.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
