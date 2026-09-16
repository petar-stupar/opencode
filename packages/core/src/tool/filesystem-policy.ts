export * as FilesystemPolicy from "./filesystem-policy"

import { FilesystemTools } from "../filesystem-tools"
import { Tool } from "./tool"

// Identity, not just a name allowlist: an application cannot replace file_read
// with an executable tool while retaining an allowed name.
const builtins = new WeakMap<Tool.AnyTool, string>()

export function builtin<T extends Tool.AnyTool>(name: string, tool: T): T {
  if (!FilesystemTools.names.some((allowed) => allowed === name))
    throw new Error(`Tool is unavailable in the filesystem-only distribution: ${name}`)
  builtins.set(tool, name)
  return tool
}

export function allows(name: string, tool: Tool.AnyTool) {
  return builtins.get(tool) === name
}
