export * as FilesystemPolicy from "./filesystem-policy"

import { Tool } from "./tool"

/** Reserved integrations remain unavailable even when supplied by a plugin. */
export function allows(name: string) {
  return !["bash", "shell", "webfetch", "websearch"].includes(name) && !name.startsWith("mcp_")
}

export function builtin<T extends Tool.AnyTool>(name: string, tool: T): T {
  if (!allows(name)) throw new Error(`Tool is unavailable in this distribution: ${name}`)
  return tool
}
