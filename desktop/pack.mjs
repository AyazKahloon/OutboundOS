// Packages the desktop app into a runnable Windows app folder using @electron/packager.
// No installer, no code-signing tooling — just OutboundOS.exe in a folder (portable).
// Run AFTER build.mjs (which produces backend.cjs + copies playwright).
import packager from "@electron/packager";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = dirname(fileURLToPath(import.meta.url));
const OUT = "F:/OutboundOS-app";

// Keep ONLY our copied playwright packages from node_modules; drop dev tooling (electron,
// electron-builder, esbuild, .pnpm, .bin, etc.) and build scripts.
function ignore(p) {
  if (!p) return false;
  if (p === "/node_modules") return false;
  if (p.startsWith("/node_modules/")) {
    return !p.startsWith("/node_modules/playwright"); // keeps playwright + playwright-core
  }
  if (p === "/build.mjs" || p === "/pack.mjs") return true;
  return false;
}

const paths = await packager({
  dir: DESKTOP,
  out: OUT,
  overwrite: true,
  platform: "win32",
  arch: "x64",
  name: "OutboundOS",
  appVersion: "1.0.0",
  asar: false,
  prune: false,
  icon: join(DESKTOP, "assets", "icon.png"),
  ignore,
});

console.log("Packaged to:", paths.join(", "));
