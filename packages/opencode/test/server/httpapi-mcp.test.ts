import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffect(testStateLayer)
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)

describe("disabled MCP HttpApi", () => {
  it.instance(
    "keeps status empty and refuses executable connections",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        expect(yield* json(yield* request(handler, "/mcp", tmp.directory))).toEqual({})
        const added = yield* request(handler, "/mcp", tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "local",
            config: { type: "local", command: ["must-never-start"], enabled: true },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toEqual({ local: { status: "disabled" } })
        expect((yield* request(handler, "/mcp/local/connect", tmp.directory, { method: "POST" })).status).toBe(404)
        expect((yield* request(handler, "/mcp/local/auth", tmp.directory, { method: "POST" })).status).toBe(400)
        expect(yield* json(yield* request(handler, "/mcp", tmp.directory))).toEqual({})
      }),
    { config: { mcp: { configured: { type: "local", command: ["must-never-start"], enabled: true } } } },
  )
})
