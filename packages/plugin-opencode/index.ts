/**
 * Directory-load entry for the bocomcode_v2 plugin loader: local configured
 * plugins must be directories whose root resolves `index`
 * (packages/plugin/host.ts → Bun.resolveSync("<dir>/index")). Re-export the
 * real implementation from src/index.ts.
 *
 * NOTE: the import MUST carry the explicit .ts extension — the fork's plugin
 * loader imports this file through its own runtime (no extension guessing),
 * and "./src/index" without an extension fails with ERR_MODULE_NOT_FOUND
 * (silently logged as "failed to load plugin" at server level).
 */
export { default } from "./src/index.ts";
