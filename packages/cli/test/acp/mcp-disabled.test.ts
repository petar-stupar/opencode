import { describe, expect, test } from "bun:test"
import type { McpServer } from "@agentclientprotocol/sdk"
import { rpcError, startWire } from "./wire-fixture"

describe("acp mcp disabled", () => {
  test("initialize advertises no MCP transport support", async () => {
    await using acp = await startWire()

    const initialized = await acp.initialize()

    expect(initialized.agentCapabilities?.mcpCapabilities).toEqual({ http: false, sse: false })
  })

  test("session/new rejects a non-empty mcpServers list", async () => {
    await using acp = await startWire()
    await acp.initialize()

    const local: McpServer = { name: "tools", command: "bun", args: ["server.ts"], env: [] }

    expect(await rpcError(acp.newSession("/workspace", [local]))).toMatchObject({
      code: -32602,
      message: expect.stringContaining("MCP servers are disabled in this distribution"),
      data: { field: "mcpServers" },
    })
    // The rejected request never reaches the server's MCP registration endpoint.
    expect(acp.server.mcp).toEqual([])
  })

  test("session/new still succeeds with an empty mcpServers list", async () => {
    await using acp = await startWire()
    await acp.initialize()

    const created = await acp.newSession("/workspace", [])

    expect(created.sessionId).toBeTruthy()
    expect(acp.server.mcp).toEqual([])
  })
})
