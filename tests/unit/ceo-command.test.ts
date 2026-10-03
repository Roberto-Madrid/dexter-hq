import { describe, expect, it } from "vitest";
import { ceoCommand } from "../../gateway/client.ts";
import { loginKindFromText } from "../../hq/codex-login.ts";

describe("path B command", () => {
  it("pins medium GPT Sol, disables tools, and sets HOME to /tmp", () => {
    const { args, env } = ceoCommand({
      model: "gpt-6.1-sol",
      effort: "medium",
      prompt: "plan",
      outputPath: "/tmp/out.json",
      codexBin: "vendor/codex/codex",
      home: "/tmp",
      disableTools: true,
    });
    expect(args).toContain("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain("--disable");
    expect(args).toContain("shell_tool");
    expect(args).toContain("read-only");
    expect(env.HOME).toBe("/tmp");
    expect(env.CODEX_HOME).toBe("/tmp/.codex");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("tells a ChatGPT login from an API-key login", () => {
    expect(loginKindFromText("Logged in using ChatGPT")).toBe("chatgpt");
    expect(loginKindFromText("Logged in using an API key")).toBe("api_key");
  });
});
