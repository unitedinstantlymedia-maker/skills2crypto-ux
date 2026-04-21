import { build as esbuild } from "esbuild";
import { readFile, rm } from "fs/promises";

// Server deps to bundle (everything else is left as `external` and resolved
// from node_modules at runtime). Keep in sync with script/build.ts.
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

async function buildServer() {
  await rm("dist/index.cjs", { force: true });

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

buildServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
