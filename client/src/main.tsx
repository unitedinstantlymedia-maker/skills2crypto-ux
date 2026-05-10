import "./polyfills";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/system/RootErrorBoundary";
import "./index.css";

// Surface module-level / async errors as visible UI rather than a black screen.
// Critical for mobile where we cannot open the browser console.
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    console.error("[window.error]", event.error || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("[unhandledrejection]", event.reason);
  });
}

createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>,
);

// Tell the inline boot script that React mounted successfully, so any later
// background errors (WebSocket reconnects, async network blips, etc.) don't
// blank out a working app with the boot error overlay.
if (typeof window !== "undefined") {
  (window as any).__appBooted = true;
}
