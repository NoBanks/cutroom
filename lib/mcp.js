// MCP client for the timeline server (shotcut-mcp). Each session gets its own
// server process and work directory, spawned over stdio.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function connectTimeline({ workdir, command, args = [] } = {}) {
  const cmd = command || process.env.SHOTCUT_MCP_CMD || "shotcut-mcp";
  const transport = new StdioClientTransport({
    command: cmd,
    args,
    env: {
      ...process.env,
      SHOTCUT_MCP_WORKDIR: workdir,
      MELT_BIN: process.env.MELT_BIN || "melt",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "cutroom", version: "2.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.find((c) => c.type === "text")?.text ?? "{}";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text, code: "non_json" };
    }
    return data;
  }

  // OpenAI-style function definitions for the model.
  function openAITools(only) {
    return tools
      .filter((t) => !only || only.includes(t.name))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
  }

  return {
    tools,
    call,
    openAITools,
    close: () => client.close(),
  };
}
