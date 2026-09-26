import * as pnx from './pnx/project.mjs';

// Compile-time plugin registry. A plugin owns project detection and target defaults.
// All probe operations remain in the core session manager.
export const plugins = [pnx];
export function defaultPlugins(root) {
  return Object.fromEntries(plugins.map(plugin => [plugin.manifest.id, plugin.detect(root)]));
}
export function pluginCatalog(root, enabled) {
  return plugins.map(plugin => ({ ...plugin.manifest, detected: plugin.detect(root), enabled: enabled[plugin.manifest.id] === true }));
}
