// Registers a happy-dom global environment for bun test, so React components
// can be rendered and interacted with in tests. Loaded via bunfig.toml
// [test] preload — see https://bun.sh/docs/test/dom.
//
// The preload is global: it applies to EVERY test file, not just the ones that
// render components. happy-dom's registrator replaces the HTTP primitives
// (fetch/Response/Request/Headers) with its own implementations, and those are
// a different realm from Bun's native ones. Anything that constructs a
// `new Response(...)` and hands it to Bun — `src/server/index.ts` does exactly
// that on every route — then produces an object Bun refuses with
// "Expected a Response object, but received Response {...}", which reads as a
// baffling type error about a value that is visibly the right shape.
//
// So: take the DOM, give back the network. Capture Bun's native HTTP globals
// before registering and restore them afterwards. Component tests need
// window/document/HTMLElement; they have no need of happy-dom's fetch stack,
// and the server tests cannot work without Bun's.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const native = {
  fetch: globalThis.fetch,
  Response: globalThis.Response,
  Request: globalThis.Request,
  Headers: globalThis.Headers,
  FormData: globalThis.FormData,
  Blob: globalThis.Blob,
} as const;

GlobalRegistrator.register();

Object.assign(globalThis, native);
