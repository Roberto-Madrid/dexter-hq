import { describe, expect, it } from "vitest";
import { ceoCommand, commandPath } from "../../gateway/client.ts";
import { loginKindFromText } from "../../hq/codex-login.ts";
import { ceoOutputSchema } from "../../hq/server.ts";

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
    expect(args).toContain('web_search="disabled"');
    expect(args).not.toContain("web_search_request");
    expect(args).not.toContain("web_search_cached");
    expect(args).toContain("read-only");
    expect(env.HOME).toBe("/tmp");
    expect(env.CODEX_HOME).toBe("/tmp/.codex");
    expect(env.TMPDIR).toBe("/tmp/dexter-codex-tmp");
    expect(env.CODEX_HOME?.startsWith(`${env.TMPDIR}/`)).toBe(false);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const bin = commandPath("vendor/codex/codex");
    expect(bin.startsWith("/")).toBe(true);
    expect(bin.endsWith("/vendor/codex/codex")).toBe(true);
  });

  it("requires every plan-card field and makes the optional flags nullable", () => {
    const schema = ceoOutputSchema();
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.newScreen.type).toEqual(["boolean", "null"]);
    expect(schema.properties.outwardAction.type).toEqual(["boolean", "null"]);
    for (const property of Object.values(schema.properties)) {
      if (property.type === "object") expect(property).toHaveProperty("additionalProperties", false);
    }
  });

  it("tells a ChatGPT login from an API-key login", () => {
    expect(loginKindFromText("Logged in using ChatGPT")).toBe("chatgpt");
    expect(loginKindFromText("Logged in using an API key")).toBe("api_key");
  });
});
