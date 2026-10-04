import { describe, expect, it } from "vitest";
import { ceoCommand } from "../../gateway/client.ts";
import {
  ceoVersionFromSheet,
  councilSeatCall,
  councilVerdictSchema,
  criticPrompt,
  parseCouncilVerdict,
} from "../../hq/council-seat.ts";
import { VerdictSchema } from "../../kernel/schemas.ts";

describe("council seat path B", () => {
  it("matches the existing verdict schema and pins path B structured output", () => {
    const schema = councilVerdictSchema();
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.properties.result.enum).toEqual(["pass", "changes", "discuss"]);
    const accepted = parseCouncilVerdict({ result: "changes", actions: ["guard null name"] });
    expect(VerdictSchema.parse(accepted)).toEqual(accepted);
    expect(() => parseCouncilVerdict({ result: "ok", actions: [] })).toThrow();
    expect(() => parseCouncilVerdict({ result: "pass" })).toThrow();
  });

  it("builds the same path B command as plan cards", () => {
    const model = ceoVersionFromSheet("ceo:\n  version: gpt-6.1-sol\n");
    const prompt = criticPrompt("Diff: x");
    const { args, env } = ceoCommand(
      councilSeatCall({
        model,
        prompt,
        schemaPath: "/tmp/verdict.json",
        outputPath: "/tmp/out.json",
      }),
    );
    expect(model).toBe("gpt-6.1-sol");
    expect(args).toContain("gpt-6.1-sol");
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain("--output-schema");
    expect(args).toContain("/tmp/verdict.json");
    expect(args).toContain("--disable");
    expect(args).toContain("shell_tool");
    expect(env.HOME).toBe("/tmp");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(prompt).toContain("Critic");
    expect(prompt).toContain("Diff: x");
  });
});
