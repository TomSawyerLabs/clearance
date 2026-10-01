import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { main } from "./serve.ts";

// Run from a source checkout: `bun src/entry/bun.ts`. The web UI is read from
// disk, from wherever `bun run build` put it. The single-file executable uses
// a generated entry point with the UI embedded instead (scripts/compile.ts).

const root = resolve(
  process.env.CLEARANCE_CLIENT_DIR ||
    join(import.meta.dir, "../../dist/client"),
);

await main((path) => {
  const file = normalize(join(root, path));
  // `join` resolves "..", so anything outside the root has left it by now.
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile())
    return null;
  return Bun.file(file);
});
