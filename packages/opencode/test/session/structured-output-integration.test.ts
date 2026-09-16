import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionPrompt.node, Session.node])))

it.instance("refuses schema-output tool requests before model execution", () =>
  Effect.gen(function* () {
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Unsupported tool" })
    const exit = yield* prompt
      .prompt({
        sessionID: session.id,
        parts: [{ type: "text", text: "Return JSON" }],
        format: { type: "json_schema", schema: { type: "object" }, retryCount: 0 },
      })
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(String(Cause.squash(exit.cause))).toContain("Structured-output tools are unavailable")
  }),
)
