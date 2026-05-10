import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile, unlink, access } from "fs/promises";

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
  // Build client using vite from client directory.
  // Note: tonconnect-manifest.json is now served dynamically by the Express
  // route in server/index.ts, so no PUBLIC_URL substitution is needed here.
  //
  // Vite only reads VITE_* vars from .env files in its root, NOT from
  // process.env. Replit's shared env vars live in the shell, so we must
  // materialize them into client/.env.production right before the build
  // (and clean up after) so they get baked into the client bundle.
  const viteEnvLines = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith("VITE_") && v != null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const tmpEnvPath = "client/.env.production";
  // Never clobber a user-managed client/.env.production. If one exists,
  // assume it's authoritative and skip materialization. Otherwise write a
  // temporary one from process.env and clean it up after the build.
  let wroteTmpEnv = false;
  if (viteEnvLines.length > 0) {
    const exists = await access(tmpEnvPath).then(() => true).catch(() => false);
    if (exists) {
      console.log(`  ${tmpEnvPath} already exists; leaving it untouched`);
    } else {
      await writeFile(tmpEnvPath, viteEnvLines + "\n");
      wroteTmpEnv = true;
      console.log(`  wrote ${tmpEnvPath} (${viteEnvLines.split("\n").length} VITE_* vars)`);
    }
  }
  process.chdir("client");
  try {
    await viteBuild();
  } finally {
    process.chdir("..");
    if (wroteTmpEnv) {
      await unlink(tmpEnvPath).catch(() => {});
    }
  }

  // Move built assets to dist/public (mkdir -p so the parent exists after rm).
  const { mkdir, rename } = await import("fs/promises");
  await mkdir("dist", { recursive: true });
  await rename("client/dist", "dist/public");

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
