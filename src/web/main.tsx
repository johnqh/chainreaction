import { createRoot } from "react-dom/client";
import { App } from "./App";

// TODO: the server-backed data/action wiring (repos, prepared status, and
// the plan/open-PR/merge/refresh callbacks) is a separate, reviewable step —
// see Task 7's report. The stubs below keep this entry point compiling and
// hardcode-free (no scope/org literals) until that wiring lands; they are
// deliberately inert rather than reaching for `fetch` themselves.
createRoot(document.getElementById("root")!).render(
  <App
    nodes={[]}
    prepared={{}}
    onPlanUpdate={() => Promise.reject(new Error("not wired: onPlanUpdate"))}
    onPlanUpdateChain={() => Promise.reject(new Error("not wired: onPlanUpdateChain"))}
    onOpenPrs={() => Promise.reject(new Error("not wired: onOpenPrs"))}
    onMerge={() => Promise.reject(new Error("not wired: onMerge"))}
    onAutoMerge={() => Promise.reject(new Error("not wired: onAutoMerge"))}
    onRefresh={() => Promise.reject(new Error("not wired: onRefresh"))}
  />,
);
