/**
 * Directory-load entry for the bocomcode_v2 plugin loader: local configured
 * plugins must be directories whose root resolves `index`
 * (packages/plugin/host.ts → Bun.resolveSync("<dir>/index")). Re-export the
 * real implementation from src/index.ts.
 */
export { default } from "./src/index";
