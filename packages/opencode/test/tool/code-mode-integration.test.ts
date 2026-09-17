import { afterEach, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { ToolRegistry } from "@/tool/registry"
import { Tool } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [
      Config.node,
      TestConfig.layer({
        directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".opencode")])),
      }),
    ],
  ]),
)
afterEach(disposeAllInstances)
const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_code_mode_files"),
  messageID: MessageID.make("msg_code_mode_files"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "execute",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

it.instance("code mode composes real filesystem operations and source editing through symlinks", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const catalog = yield* registry.tools({
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("gpt-6"),
      agent: yield* agents.defaultInfo(),
    })
    const tool = catalog.find((tool) => tool.id === "execute")!
    const result = yield* tool.execute(
      {
        code: `
    await tools.directory_create({path: "src"})
    await tools.file_create({path: "src/test.ts", content: "export const value = 1\\n"})
    await tools.edit({filePath: "src/test.ts", oldString: "value = 1", newString: "value = 2"})
    await tools.file_append({path: "src/test.ts", content: "// done\\n"})
    const content = JSON.parse(await tools.file_read({path: "src/test.ts"})).content
    const paths = await tools.glob({pattern: "src/*.ts"})
    const matches = await tools.grep({pattern: "value = 2", path: "src"})
    const listing = JSON.parse(await tools.directory_list({path: "src"}))
    return {content, paths, matches, listing}
  `,
      },
      ctx,
    )
    const output = JSON.parse(result.output)
    expect(output.content).toContain("value = 2")
    expect(output.content).toContain("// done")
    expect(output.paths).toContain("test.ts")
    expect(output.matches).toContain("value = 2")
    expect(output.listing.entries).toContainEqual(expect.objectContaining({ name: "test.ts", type: "file" }))
    const instance = yield* TestInstance
    const fs = yield* Effect.promise(() => import("fs/promises"))
    yield* Effect.promise(() =>
      fs.symlink(path.join(instance.directory, "src/test.ts"), path.join(instance.directory, "link.ts")),
    )
    yield* tool.execute(
      { code: `return await tools.edit({filePath: "link.ts", oldString: "value = 2", newString: "value = 3"})` },
      ctx,
    )
    expect(yield* Effect.promise(() => Bun.file(path.join(instance.directory, "src/test.ts")).text())).toContain(
      "value = 3",
    )
  }),
)

it.instance("loads a custom tool and exposes it inside code mode", () =>
  Effect.gen(function* () {
    const instance = yield* TestInstance
    yield* Effect.promise(() =>
      Bun.write(
        path.join(instance.directory, ".opencode/tools/greet.ts"),
        `export default { description: "A custom greeting", args: {}, execute: async () => "hello from plugin" }`,
      ),
    )
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const catalog = yield* registry.tools({
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("gpt-6"),
      agent: yield* agents.defaultInfo(),
    })
    expect(catalog.map((tool) => tool.id)).toContain("greet")
    const tool = catalog.find((tool) => tool.id === "execute")!
    expect(tool.description).toContain("tools.greet")
    expect((yield* tool.execute({ code: "return await tools.greet({})" }, ctx)).output).toBe("hello from plugin")
  }),
)

it.instance("permission and per-prompt filtering also restrict the script catalog", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const agents = yield* Agent.Service
    const catalog = yield* registry.tools({
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("gpt-6"),
      agent: yield* agents.defaultInfo(),
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "task", pattern: "*", action: "deny" },
      ],
      disabled: ["grep"],
    })
    const tool = catalog.find((tool) => tool.id === "execute")!
    for (const name of ["file_write", "edit", "apply_patch", "task", "grep", "bash", "webfetch", "mcp_remote"]) {
      expect(catalog.map((item) => item.id)).not.toContain(name)
      expect(tool.description).not.toContain(`tools.${name}(`)
    }
    expect(tool.description).toContain("tools.file_read")
    expect(tool.description).toContain("tools.directory_list")
    const restricted = yield* registry.tools({
      providerID: ProviderV2.ID.openai,
      modelID: ModelV2.ID.make("gpt-6"),
      agent: yield* agents.defaultInfo(),
      permission: [{ permission: "read", pattern: "*", action: "deny" }],
    })
    expect(restricted.map((tool) => tool.id)).not.toContain("directory_list")
    expect(restricted.find((tool) => tool.id === "execute")!.description).not.toContain("tools.directory_list(")
  }),
)
