import path from "path";
import express from "express";

export function log(message: string) {
  console.log(`[server] ${message}`);
}

export function serveStatic(app: express.Express) {
  const distPath = path.resolve("dist");

  app.use(express.static(distPath));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}


