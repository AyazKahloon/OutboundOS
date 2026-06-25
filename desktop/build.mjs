// Prepares the desktop app for packaging:
//  1) bundles the backend (dist/app-api.js + all pure-JS deps) into ./backend.cjs
//     — playwright stays external (it spawns a driver and must remain a real package).
//  2) copies the real playwright + playwright-core packages into ./node_modules so the
//     packaged app can require them without relying on pnpm's symlink layout.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DESKTOP, "..");
const BACKEND = join(ROOT, "backend");

// 1) bundle
console.log("Bundling backend → backend.cjs …");
await build({
  entryPoints: [join(BACKEND, "dist", "app-api.js")],
  outfile: join(DESKTOP, "backend.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["playwright", "playwright-core", "canvas", "bufferutil", "utf-8-validate", "fsevents"],
  legalComments: "none",
  logLevel: "info",
});

// 2) copy playwright + playwright-core (dereferenced) into desktop/node_modules.
// playwright-core is a transitive dep, so resolve it from playwright's own location (pnpm).
const backendRequire = createRequire(join(BACKEND, "package.json"));
const pwDir = dirname(backendRequire.resolve("playwright/package.json"));
const pwRequire = createRequire(join(pwDir, "package.json"));
const pwcDir = dirname(pwRequire.resolve("playwright-core/package.json"));

for (const [name, src] of [["playwright", pwDir], ["playwright-core", pwcDir]]) {
  const dest = join(DESKTOP, "node_modules", name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`Copied ${name} → node_modules/${name}`);
}

// jsdom keeps a `require.resolve("./xhr-sync-worker.js")` that runs at load. We never use
// synchronous XHR (we only parse static HTML), but the file must exist next to the bundle
// so the resolve doesn't throw. Copy it alongside backend.cjs.
const jsdomDir = dirname(backendRequire.resolve("jsdom/package.json"));
cpSync(join(jsdomDir, "lib", "jsdom", "living", "xhr", "xhr-sync-worker.js"), join(DESKTOP, "xhr-sync-worker.js"), { dereference: true });
console.log("Copied jsdom xhr-sync-worker.js");

if (!existsSync(join(DESKTOP, "backend.cjs"))) throw new Error("backend.cjs was not produced");
console.log("Build prep complete.");
