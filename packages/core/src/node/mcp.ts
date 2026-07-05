import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../tools.js";

/**
 * MCP support (Phase 11). Connects to Model Context Protocol servers over
 * stdio and exposes their tools to the agent as ordinary Tools, named
 * mcp_<server>_<tool>. The approval policy treats mcp_ tools as external:
 * they ask before running except in full-auto mode.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  tools: Tool[];
  /** Per-server tool counts for status display. */
  servers: Record<string, number>;
  dispose(): Promise<void>;
}

const CALL_TIMEOUT_MS = 60_000;

export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  opts: { onError?: (server: string, err: unknown) => void } = {},
): Promise<McpConnection> {
  const tools: Tool[] = [];
  const counts: Record<string, number> = {};
  const clients: Client[] = [];

  for (const [name, config] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...(process.env as Record<string, string>), ...config.env },
        stderr: "ignore",
      });
      const client = new Client({ name: "wright", version: "0.1.0" });
      await client.connect(transport);
      clients.push(client);

      const { tools: mcpTools } = await client.listTools();
      counts[name] = mcpTools.length;
      for (const mcpTool of mcpTools) {
        tools.push(wrapMcpTool(client, name, mcpTool.name, mcpTool.description ?? "", mcpTool.inputSchema));
      }
    } catch (err) {
      counts[name] = 0;
      opts.onError?.(name, err);
    }
  }

  return {
    tools,
    servers: counts,
    dispose: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

function wrapMcpTool(
  client: Client,
  server: string,
  toolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): Tool {
  const safeName = `mcp_${server}_${toolName}`.replace(/[^\w-]/g, "_").slice(0, 64);
  return {
    requiresApproval: true,
    definition: {
      type: "function",
      function: {
        name: safeName,
        description: `[MCP tool from "${server}"] ${description}`.slice(0, 1024),
        parameters: inputSchema ?? { type: "object", properties: {} },
      },
    },
    async execute(args) {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      const parts: string[] = [];
      for (const item of (result.content as Array<{ type: string; text?: string }>) ?? []) {
        if (item.type === "text" && item.text) parts.push(item.text);
        else parts.push(`[${item.type} content]`);
      }
      const output = parts.join("\n").slice(0, 30_000) || "(no output)";
      return { ok: result.isError !== true, output };
    },
  };
}
