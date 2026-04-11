import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

await build({
  bundle: true,
  entryPoints: {
    cli: path.join(projectRoot, "src", "cli.ts"),
  },
  format: "cjs",
  outdir: path.join(projectRoot, "dist"),
  platform: "node",
});
