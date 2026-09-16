export * as CodeModeTool from "./code-mode"

import { Cause, Effect, Schema } from "effect"
import { CodeMode, toolError } from "@opencode-ai/codemode"
import { Tool } from "./tool"
import { ToolJsonSchema } from "./json-schema"
import { ToolInvocation } from "./invocation"
import { FilesystemPolicy } from "@opencode-ai/core/tool/filesystem-policy"

export const CODE_MODE_TOOL = "execute"
export const Parameters = Schema.Struct({
  code: Schema.String.annotate({ description: "Confined script body. Call the listed tools and return a JSON value." }),
})

type Call = {
  tool: string
  status: "running" | "completed" | "error"
  input?: unknown
  title?: string
  metadata?: Record<string, unknown>
}

/** The host passes the same permission-filtered catalog exposed to the model. */
export const make = Effect.fn("CodeModeTool.make")(function* (catalog: readonly Tool.Def[]) {
  const sandbox = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  const invoke = yield* ToolInvocation.make
  const available = catalog.filter((tool) => tool.id !== CODE_MODE_TOOL && FilesystemPolicy.allows(tool.id))
  const tree = (run: (tool: Tool.Def, input: unknown) => Effect.Effect<unknown, unknown>) =>
    Object.fromEntries(
      available.map((tool) => [
        tool.id,
        sandbox.Tool.make({
          description: tool.description,
          input: ToolJsonSchema.fromTool(tool) as Parameters<typeof sandbox.Tool.make>[0]["input"],
          output: { type: "string", description: "The tool's output text. Use JSON.parse for tools returning JSON." },
          run: (input) => run(tool, input),
        }),
      ]),
    )
  const info = yield* Tool.define(
    CODE_MODE_TOOL,
    Effect.succeed({
      description: [
        "Run a confined orchestration script over the enabled tools. Each call retains its normal permissions and plugin hooks.",
        "Tools return output text; JSON.parse the output of file_read or directory_walk to access their fields.",
        "There is no MCP, shell, module loading, or ambient filesystem/network access. execute cannot call itself.",
        CodeMode.make({ tools: tree(() => Effect.die("Catalog preview is not executable")) }).instructions(),
      ].join("\n\n"),
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const calls: Call[] = []
          const attachments: NonNullable<Tool.ExecuteResult["attachments"]> = []
          const publish = () => ctx.metadata({ metadata: { toolCalls: calls.map((call) => ({ ...call })) } })
          const runtime = CodeMode.make({
            tools: tree((tool, args) =>
              Effect.gen(function* () {
                if (ctx.abort.aborted) return yield* Effect.interrupt
                const call: Call = { tool: tool.id, status: "running", input: args }
                calls.push(call)
                const callID = `${ctx.callID ?? CODE_MODE_TOOL}/${calls.length}`
                yield* publish()
                const result = yield* invoke(tool, args, {
                  ...ctx,
                  callID,
                  metadata: (value) =>
                    Effect.gen(function* () {
                      call.title = value.title
                      call.metadata = value.metadata
                      yield* publish()
                    }),
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.gen(function* () {
                      call.status = "error"
                      yield* publish()
                      if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt
                      const error = Cause.squash(cause)
                      return yield* Effect.fail(
                        toolError(error instanceof Error ? error.message : String(error), error),
                      )
                    }),
                  ),
                )
                call.status = "completed"
                call.title = result.title
                call.metadata = result.metadata
                if (result.attachments) attachments.push(...result.attachments)
                yield* publish()
                return result.output
              }),
            ),
          })
          const abort = Effect.callback<never>((resume) => {
            const handler = () => resume(Effect.interrupt)
            if (ctx.abort.aborted) return handler()
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })
          const result = yield* Effect.raceFirst(runtime.execute(input.code), abort)
          const logs = result.logs?.length ? `\n\nLogs:\n${result.logs.join("\n")}` : ""
          if (!result.ok) return yield* Effect.die(new Error(result.error.message + logs))
          return {
            title: CODE_MODE_TOOL,
            output:
              (typeof result.value === "string"
                ? result.value
                : (JSON.stringify(result.value, null, 2) ?? "undefined")) + logs,
            metadata: { toolCalls: calls },
            ...(attachments.length ? { attachments } : {}),
          }
        }),
    }),
  )
  return yield* Tool.init(info)
})
