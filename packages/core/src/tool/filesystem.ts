export * as FilesystemTool from "./filesystem"

import { Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode-ai/llm"
import { makeLocationNode } from "../effect/app-node"
import { FilesystemTools } from "../filesystem-tools"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { Tool } from "./tool"
import { FilesystemPolicy } from "./filesystem-policy"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    const make = <S extends Schema.Codec<FilesystemTools.Input>>(name: FilesystemTools.Name, input: S) =>
      FilesystemPolicy.builtin(
        name,
        Tool.withPermission(
          Tool.make({
            description: FilesystemTools.descriptions[name],
            input,
            output: Schema.String,
            toModelOutput: (result) => [{ type: "text", text: result.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const authorize = Effect.fnUntraced(function* (
                  targets: readonly LocationMutation.Target[],
                  action: string,
                ) {
                  for (const target of targets) {
                    if (!target.externalDirectory) continue
                    yield* permission.assert({
                      ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                  }
                  yield* permission.assert({
                    action,
                    resources: targets.map((target) => target.resource),
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                })
                const resolved = yield* FilesystemTools.resolve(mutation, name, input)
                yield* authorize(
                  resolved.destination ? [resolved.target, resolved.destination] : [resolved.target],
                  FilesystemTools.action(name),
                )
                return yield* FilesystemTools.execute(fs, name, input, resolved.target, resolved.destination, (path) =>
                  mutation.resolve({ path, kind: "directory", allowExternalSymlinks: true }).pipe(
                    Effect.flatMap((target) => authorize([target], "read")),
                    Effect.mapError((error) => new FilesystemTools.Error({ message: String(error) })),
                  ),
                )
              }).pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) }))),
          }),
          FilesystemTools.action(name),
        ),
      )

    yield* tools
      .register({
        file_read: make("file_read", FilesystemTools.inputs.file_read),
        file_write: make("file_write", FilesystemTools.inputs.file_write),
        file_append: make("file_append", FilesystemTools.inputs.file_append),
        file_create: make("file_create", FilesystemTools.inputs.file_create),
        file_remove: make("file_remove", FilesystemTools.inputs.file_remove),
        file_rename: make("file_rename", FilesystemTools.inputs.file_rename),
        directory_create: make("directory_create", FilesystemTools.inputs.directory_create),
        directory_rename: make("directory_rename", FilesystemTools.inputs.directory_rename),
        directory_remove: make("directory_remove", FilesystemTools.inputs.directory_remove),
        directory_walk: make("directory_walk", FilesystemTools.inputs.directory_walk),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/filesystem",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, LocationMutation.node, PermissionV2.node],
})
