import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("opencode mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "rejects remote MCP setup without writing configuration",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 1)

        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "opencode", "opencode.json")).exists()),
        ).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects local MCP setup without starting a server",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 1)

        expect(
          yield* Effect.promise(() => Bun.file(path.join(home, ".config", "opencode", "opencode.json")).exists()),
        ).toBe(false)
      }),
    60_000,
  )
})
