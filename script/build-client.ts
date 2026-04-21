import { build as viteBuild } from "vite";
import { readFile, writeFile, rm } from "fs/promises";
import path from "path";

/**
 * Client-only build for Netlify. Outputs to client/dist.
 * Post-processes tonconnect-manifest.json by substituting the
 * __PUBLIC_URL__ token with PUBLIC_URL (or VITE_PUBLIC_URL) env var.
 */
async function buildClient() {
  const publicUrl = (process.env.PUBLIC_URL || process.env.VITE_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!publicUrl) {
    console.warn(
      "[build:client] WARNING: neither PUBLIC_URL nor VITE_PUBLIC_URL is set. " +
        "tonconnect-manifest.json will keep the __PUBLIC_URL__ placeholder, " +
        "which TonKeeper will reject in production."
    );
  } else {
    // Make sure VITE_PUBLIC_URL is visible to vite during the build.
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
    const manifestPath = path.join("client", "dist", "tonconnect-manifest.json");
    try {
      const raw = await readFile(manifestPath, "utf-8");
      const replaced = raw.replace(/__PUBLIC_URL__/g, publicUrl);
      await writeFile(manifestPath, replaced, "utf-8");
      console.log(`[build:client] tonconnect-manifest.json → ${publicUrl}`);
    } catch (err: any) {
      console.warn(`[build:client] could not post-process manifest: ${err?.message || err}`);
    }
  }
}

buildClient().catch((err) => {
  console.error(err);
  process.exit(1);
});
