import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { metaImagesPlugin } from "./vite-plugin-meta-images"; // <-- named import

export default defineConfig({
  plugins: [react(), runtimeErrorOverlay(), metaImagesPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared": path.resolve(import.meta.dirname, "../shared"),
      "@assets": path.resolve(import.meta.dirname, "../attached_assets"),
      // Force every package (wagmi, @reown/appkit, @tanstack/react-query, etc.)
      // to resolve React/ReactDOM to the SAME copy. Without this, transitive
      // deps can pull a second React, leaving its hook dispatcher null and
      // causing "Cannot read properties of null (reading 'useRef')" the
      // moment WagmiProvider mounts on mobile.
      react: path.resolve(import.meta.dirname, "../node_modules/react"),
      "react-dom": path.resolve(import.meta.dirname, "../node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(import.meta.dirname, "../node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(import.meta.dirname, "../node_modules/react/jsx-dev-runtime.js")
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime"]
  },
  optimizeDeps: {
    include: ["socket.io-client", "react", "react-dom", "react/jsx-runtime"]
  },
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Target broadly compatible JS so older mobile browsers (e.g. iOS Safari
    // < 14) can at least parse the bundle and run our error boundary instead
    // of failing silently with a black screen.
    target: ["es2020", "safari14", "chrome87", "firefox78", "edge88"]
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true
  }
});
