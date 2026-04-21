import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile } from "fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@neondatabase/serverless",
  "@upstash/redis",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "nanoid",
  "pg",
  "socket.io",
  "ws",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  // Build client using vite from client directory
  const publicUrl = (process.env.PUBLIC_URL || process.env.VITE_PUBLIC_URL || "").replace(/\/+$/, "");
  if (publicUrl) process.env.VITE_PUBLIC_URL = publicUrl;
  process.chdir("client");
  try {
    await viteBuild();
  } finally {
    process.chdir("..");
  }

  // Move built assets to dist/public (mkdir -p so the parent exists after rm).
  const { mkdir, rename } = await import("fs/promises");
  await mkdir("dist", { recursive: true });
  await rename("client/dist", "dist/public");

  // Post-process tonconnect-manifest.json (no-op if PUBLIC_URL not set).
  if (publicUrl) {
    const { readFile, writeFile } = await import("fs/promises");
    const manifestPath = "dist/public/tonconnect-manifest.json";
    try {
      const raw = await readFile(manifestPath, "utf-8");
      await writeFile(manifestPath, raw.replace(/__PUBLIC_URL__/g, publicUrl), "utf-8");
      console.log(`[build] tonconnect-manifest.json → ${publicUrl}`);
    } catch (err: any) {
      console.warn(`[build] could not post-process manifest: ${err?.message || err}`);
    }
  } else {
    console.warn("[build] PUBLIC_URL not set — tonconnect-manifest.json keeps the __PUBLIC_URL__ placeholder.");
  }

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
