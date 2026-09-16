import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Agent } from "@/agent/agent"
import { Question } from "@/question"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { FilesystemTool } from "./filesystem"
import { QuestionTool } from "./question"
import { Tool } from "./tool"
import { Truncate } from "./truncate"
import { ReadTool } from "./read"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ read: Tool.InferDef<typeof ReadTool> }>
  readonly tools: (model: {
    providerID: ProviderV2.ID
    modelID: ModelV2.ID
    agent: Agent.Info
    permission?: PermissionV1.Ruleset
  }) => Effect.Effect<Tool.Def[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const question = yield* QuestionTool
    const filesystem = yield* Effect.all(FilesystemTool.all)
    // The legacy read is used only to expand user-supplied file attachments.
    const read = yield* ReadTool
    const builtin: Tool.Def[] = yield* Effect.all([Tool.init(question), ...filesystem.map((tool) => Tool.init(tool))])
    const attachment = yield* Tool.init(read)
    const all = () => Effect.succeed([...builtin])
    return Service.of({
      ids: () => Effect.succeed(builtin.map((tool) => tool.id)),
      all,
      named: () => Effect.succeed({ read: attachment }),
      tools: all,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Question.node, Agent.node, FSUtil.node, Truncate.node, Instruction.node, LSP.node],
})

export * as ToolRegistry from "./registry"
