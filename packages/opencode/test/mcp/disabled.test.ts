import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MCP } from "@/mcp"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))

it.effect("keeps MCP catalogs empty and refuses connection and OAuth startup", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    expect(yield* mcp.add("local", { type: "local", command: ["must-never-start"], enabled: true })).toEqual({
      status: { status: "disabled" },
    })
    expect(
      yield* mcp.add("remote", { type: "remote", url: "https://must-never-connect.invalid", enabled: true }),
    ).toEqual({ status: { status: "disabled" } })
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
    expect(yield* mcp.clients()).toEqual({})
    expect(yield* mcp.resources()).toEqual({})
    expect(yield* mcp.resourceTemplates()).toEqual({})
    expect(yield* mcp.prompts()).toEqual({})
    expect(yield* mcp.instructions()).toEqual([])
    expect(yield* mcp.readResource("remote", "secret")).toBeUndefined()
    expect(yield* mcp.getPrompt("remote", "prompt")).toBeUndefined()
    expect(Exit.isFailure(yield* mcp.connect("local").pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* mcp.startAuth("remote").pipe(Effect.exit))).toBe(true)
    expect(yield* mcp.authenticate("remote")).toEqual({ status: "disabled" })
    expect(yield* mcp.finishAuth("remote", "code")).toEqual({ status: "disabled" })
    expect(yield* mcp.supportsOAuth("remote")).toBe(false)
    expect(yield* mcp.hasStoredTokens("remote")).toBe(false)
  }),
)
