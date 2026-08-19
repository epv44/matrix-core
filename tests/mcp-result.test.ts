import { describe, expect, it } from "vitest";
import { result } from "../src/mcp/server.js";

describe("MCP review presentation", () => {
  it("uses Markdown text while retaining complete structured content", () => {
    const value = { reviewMarkdown: "## AgentSmith Review", review: { findings: [{ id: "finding-1" }] } };
    const output = result(value);
    expect(output.content[0].text).toBe(value.reviewMarkdown);
    expect(output.structuredContent).toEqual(value);
  });
});
