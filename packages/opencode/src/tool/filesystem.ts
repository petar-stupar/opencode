export * as FilesystemTool from "./filesystem"

import { Effect, Schema } from "effect"
import { FilesystemTools } from "@opencode-ai/core/filesystem-tools"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { InstanceState } from "@/effect/instance-state"
import { Tool } from "./tool"

export const make = <S extends Schema.Decoder<FilesystemTools.Input>>(name: FilesystemTools.Name, parameters: S) =>
  Tool.define(
    name,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return {
        description: FilesystemTools.descriptions[name],
        parameters,
        execute: (input: S["Type"], context: Tool.Context) =>
          Effect.gen(function* () {
            const instance = yield* InstanceState.context
            const mutation = yield* LocationMutation.make(fs, instance.directory)
            const authorize = Effect.fnUntraced(function* (
              targets: readonly LocationMutation.Target[],
              action: string,
            ) {
              for (const target of targets) {
                if (!target.externalDirectory) continue
                yield* context.ask({
                  permission: "external_directory",
                  patterns: [target.externalDirectory.resource],
                  always: [target.externalDirectory.save],
                  metadata: {},
                })
              }
              yield* context.ask({
                permission: action,
                patterns: targets.map((target) => target.resource),
                always: ["*"],
                metadata: {},
              })
            })
            const resolved = yield* FilesystemTools.resolve(mutation, name, input)
            yield* authorize(
              resolved.destination ? [resolved.target, resolved.destination] : [resolved.target],
              FilesystemTools.action(name),
            )
            const output = yield* FilesystemTools.execute(
              fs,
              name,
              input,
              resolved.target,
              resolved.destination,
              (path) =>
                mutation.resolve({ path, kind: "directory", allowExternalSymlinks: true }).pipe(
                  Effect.flatMap((target) => authorize([target], "read")),
                  Effect.mapError((error) => new FilesystemTools.Error({ message: String(error) })),
                ),
            )
            return { title: resolved.target.resource, output, metadata: {} }
          }).pipe(Effect.orDie),
      }
    }),
  )

export const all = [
  make("file_read", FilesystemTools.inputs.file_read),
  make("file_write", FilesystemTools.inputs.file_write),
  make("file_append", FilesystemTools.inputs.file_append),
  make("file_create", FilesystemTools.inputs.file_create),
  make("file_remove", FilesystemTools.inputs.file_remove),
  make("file_rename", FilesystemTools.inputs.file_rename),
  make("directory_create", FilesystemTools.inputs.directory_create),
  make("directory_rename", FilesystemTools.inputs.directory_rename),
  make("directory_remove", FilesystemTools.inputs.directory_remove),
  make("directory_walk", FilesystemTools.inputs.directory_walk),
]
