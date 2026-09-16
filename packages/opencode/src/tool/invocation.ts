export * as ToolInvocation from "./invocation"

import { Effect } from "effect"
import { Plugin } from "@/plugin"
import { Tool } from "./tool"

/** Shared hook boundary for direct calls and code-mode child calls. */
export const make = Effect.gen(function* () {
  const plugin = yield* Plugin.Service
  return Effect.fn("ToolInvocation.execute")(function* (tool: Tool.Def, input: unknown, ctx: Tool.Context) {
    const args = input as Record<string, unknown>
    const callID = ctx.callID ?? tool.id
    yield* plugin.trigger("tool.execute.before", { tool: tool.id, sessionID: ctx.sessionID, callID }, { args })
    const result = yield* tool.execute(args, ctx)
    yield* plugin.trigger("tool.execute.after", { tool: tool.id, sessionID: ctx.sessionID, callID, args }, result)
    return result
  })
})
