import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ToolRegistry } from "@/tool/registry"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const expected = [
  "question",
  "edit",
  "apply_patch",
  "todowrite",
  "skill",
  "task",
  "lsp",
  "glob",
  "grep",
  "execute",
  "file_read",
  "file_write",
  "file_append",
  "file_create",
  "file_remove",
  "file_rename",
  "directory_create",
  "directory_rename",
  "directory_remove",
  "directory_walk",
]
const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
      }),
    ],
    [
      RuntimeFlags.node,
      RuntimeFlags.layer({
        experimentalCodeMode: true,
        experimentalLspTool: true,
        experimentalPlanMode: true,
        enableExa: true,
        enableParallel: true,
      }),
    ],
  ]),
)

afterEach(disposeAllInstances)

describe("filesystem-oriented legacy registry", () => {
  it.instance("exposes the intended tools regardless of experimental flags or model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      expect((yield* registry.ids()).sort()).toEqual([...expected].sort())
      for (const modelID of ["gpt-6", "gpt-oss", "claude-opus"])
        expect(
          (yield* registry.tools({
            providerID: ProviderV2.ID.openai,
            modelID: ModelV2.ID.make(modelID),
            agent: yield* agents.defaultInfo(),
          }))
            .map((tool) => tool.id)
            .sort(),
        ).toEqual([...expected].sort())
      for (const tool of yield* registry.all()) expect(ToolJsonSchema.fromTool(tool).type).toBe("object")
    }),
  )

  it.instance("loads custom tools from configuration directories", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const directory = path.join(instance.directory, ".opencode", "tools")
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "greet.ts"),
          'export default {description: "Greeting", args: {}, execute: async () => "hi"}',
        ),
      )
      const registry = yield* ToolRegistry.Service
      expect((yield* registry.ids()).sort()).toEqual([...expected, "greet"].sort())
    }),
  )

  it.instance("executes the same direct filesystem operations in legacy sessions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.all()
      const context = {
        sessionID: SessionID.make("ses_filesystem_legacy"),
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const write = tools.find((tool) => tool.id === "file_write")!
      const append = tools.find((tool) => tool.id === "file_append")!
      const read = tools.find((tool) => tool.id === "file_read")!
      yield* write.execute({ path: "file", content: "one" }, context)
      yield* append.execute({ path: "file", content: "two" }, context)
      expect(JSON.parse((yield* read.execute({ path: "file" }, context)).output).content).toBe("onetwo")
    }),
  )
})
