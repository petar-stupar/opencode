/**
 * Tool catalog policy for the filesystem-oriented distribution. Reserved names
 * never reach the model or execution, regardless of which plugin registers them,
 * and the excluded built-in plugins are not activated at all.
 */
export * as FilesystemPolicy from "./filesystem-policy.js"

export const reserved = ["bash", "shell", "webfetch", "websearch"] as const

const names: ReadonlySet<string> = new Set(reserved)

export const allows = (name: string) => !names.has(name) && !name.startsWith("mcp_")

export const excluded: ReadonlySet<string> = new Set([
  "opencode.tool.read",
  "opencode.tool.write",
  "opencode.tool.shell",
  "opencode.tool.webfetch",
  "opencode.tool.websearch",
  "opencode.tools",
  "opencode.tools.mcp-resources",
  "opencode.browser",
])

export const plugins = <T extends { readonly id: string }>(list: readonly T[]) =>
  list.filter((plugin) => !excluded.has(plugin.id))
