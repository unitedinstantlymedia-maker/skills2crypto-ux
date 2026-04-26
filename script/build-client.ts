import { build as viteBuild } from "vite";
import { rm, writeFile } from "fs/promises";
import path from "path";

/**
 * Client-only build for Netlify. Outputs to client/dist.
 *
 * In monolith deploys (Replit / Railway) the manifest is served dynamically
 * by the Express route in server/index.ts, so client/public has no static
 * manifest. For the Netlify split deploy there is no Express server, so we
 * generate tonconnect-manifest.json at build time from PUBLIC_URL.
 */
async function buildClient() {
  const publicUrl = (process.env.PUBLIC_URL || process.env.VITE_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicUrl) {
    console.warn(
      "[build:client] WARNING: neither PUBLIC_URL nor VITE_PUBLIC_URL is set. " +
        "tonconnect-manifest.json will NOT be generated and TonKeeper will reject the connection."
    );
  } else {
    process.env.VITE_PUBLIC_URL = publicUrl;
  }

  await rm("client/dist", { recursive: true, force: true });

  const cwd = process.cwd();
  process.chdir("client");
  try {
    await viteBuild();
  } finally {
    process.chdir(cwd);
  }

  if (publicUrl) {
    const manifest = {
      url: publicUrl,
      name: "Skills2Crypto",
      iconUrl: `${publicUrl}/favicon.png`,
    };
    const manifestPath = path.join("client", "dist", "tonconnect-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    console.log(`[build:client] tonconnect-manifest.json → ${publicUrl}`);
  }
}

buildClient().catch((err) => {
  console.error(err);
  process.exit(1);
});
