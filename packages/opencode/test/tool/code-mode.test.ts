import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { CodeModeTool } from "@/tool/code-mode"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code_mode"),
  messageID: MessageID.make("msg_code_mode"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "execute-1",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}
const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [] }
const it = testEffect(
  Layer.mergeAll(
    Layer.mock(Agent.Service, { get: () => Effect.succeed(agent) }),
    Layer.mock(Truncate.Service, { output: (content) => Effect.succeed({ content, truncated: false }) }),
    Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
  ),
)
const echo = Tool.define(
  "echo",
  Effect.succeed({
    description: "Return a message",
    parameters: Schema.Struct({ text: Schema.String }),
    execute: (input: { text: string }, context: Tool.Context) =>
      Effect.gen(function* () {
        yield* context.ask({ permission: "echo", patterns: [input.text], always: ["*"], metadata: {} })
        return { title: "echo", output: input.text, metadata: {} }
      }),
  }),
)

describe("code mode over host tools", () => {
  it.effect("composes tools, retains permission checks and captures logs", () =>
    Effect.gen(function* () {
      const leaf = yield* echo.pipe(Effect.flatMap(Tool.init))
      const tool = yield* CodeModeTool.make([leaf])
      const asked: string[] = []
      const result = yield* tool.execute(
        {
          code: `const a = await tools.echo({text: "hello"}); console.log(a); return await tools.echo({text: a + " world"})`,
        },
        {
          ...ctx,
          ask: (req) =>
            Effect.sync(() => {
              asked.push(req.patterns[0]!)
            }),
        },
      )
      expect(result.output).toBe("hello world\n\nLogs:\nhello")
      expect(asked).toEqual(["hello", "hello world"])
      expect(result.metadata.toolCalls.map((call) => call.status)).toEqual(["completed", "completed"])
      expect(tool.description).toContain("tools.echo")
    }),
  )

  it.effect("validates leaf inputs and makes failures catchable inside scripts", () =>
    Effect.gen(function* () {
      const leaf = yield* echo.pipe(Effect.flatMap(Tool.init))
      const tool = yield* CodeModeTool.make([leaf])
      const result = yield* tool.execute(
        { code: `try { await tools.echo({text: 42}) } catch (e) { return e.message }` },
        ctx,
      )
      expect(result.output).toContain("invalid arguments")
      expect(result.metadata.toolCalls[0]?.status).toBe("error")
    }),
  )

  it.effect("does not expose recursion, disabled integrations, or ambient host APIs", () =>
    Effect.gen(function* () {
      const leaf = yield* echo.pipe(Effect.flatMap(Tool.init))
      const tool = yield* CodeModeTool.make([
        leaf,
        ...["execute", "bash", "shell", "webfetch", "websearch", "mcp_remote"].map((id) => ({ ...leaf, id })),
      ])
      for (const code of [
        "return await tools.execute({code: 'return 1'})",
        "return await tools.bash({})",
        "return await tools.mcp_remote({})",
        "return process.env",
        "return await fetch('https://example.com')",
        "return Bun.file('secret')",
        "return require('fs')",
      ]) {
        const result = yield* tool.execute({ code }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect(tool.description).not.toContain("tools.mcp_remote")
    }),
  )

  it.effect("preserves leaf attachments outside the interpreter", () =>
    Effect.gen(function* () {
      const tool = yield* CodeModeTool.make([
        {
          id: "image",
          description: "Return image",
          parameters: Schema.Struct({}),
          execute: () =>
            Effect.succeed({
              title: "image",
              output: "attached",
              metadata: {},
              attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=" }],
            }),
        },
      ])
      const result = yield* tool.execute({ code: "await tools.image({}); return 'done'" }, ctx)
      expect(result.output).toBe("done")
      expect(result.attachments).toHaveLength(1)
      expect(result.output).not.toContain("aGVsbG8=")
    }),
  )

  it.effect("runs hooks for nested calls with distinct IDs", () =>
    Effect.gen(function* () {
      const events: string[] = []
      const leaf = yield* echo.pipe(Effect.flatMap(Tool.init))
      const tool = yield* CodeModeTool.make([leaf]).pipe(
        Effect.provide(
          Layer.mock(Plugin.Service, {
            trigger: (name, input, output) =>
              Effect.sync(() => {
                events.push(
                  `${name}:${typeof input === "object" && input !== null && "callID" in input ? input.callID : ""}`,
                )
                return output
              }),
          }),
        ),
      )
      yield* tool.execute({ code: `await tools.echo({text: "a"}); return await tools.echo({text: "b"})` }, ctx)
      expect(events).toEqual([
        "tool.execute.before:execute-1/1",
        "tool.execute.after:execute-1/1",
        "tool.execute.before:execute-1/2",
        "tool.execute.after:execute-1/2",
      ])
    }),
  )

  it.effect("interrupts an active child when the enclosing tool is cancelled", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const abort = new AbortController()
      const tool = yield* CodeModeTool.make([
        {
          id: "wait",
          description: "Wait",
          parameters: Schema.Struct({}),
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
        },
      ])
      const fiber = yield* tool
        .execute({ code: "return await tools.wait({})" }, { ...ctx, abort: abort.signal })
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      abort.abort()
      yield* Deferred.await(stopped)
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
    }),
  )
})
