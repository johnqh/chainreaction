import { createRoot } from "react-dom/client";
import { Root } from "./Root";

// The real entry point: Root loads repos and the dependency graph from the
// hosted API on mount and wires every App callback to apiClient — see
// Root.tsx for the loading/error states and the callback wiring itself.
// Kept here as a one-line mount so Root (the actual logic) stays a plain
// component, testable with @testing-library/react like every other screen
// in this app instead of only being exercisable by loading this module and
// requiring a real DOM `#root` element to exist first.
createRoot(document.getElementById("root")!).render(<Root />);
