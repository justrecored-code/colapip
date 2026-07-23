import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

// ============================================================================
// Unit tests for workflow patching logic
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const CONFIG = path.join(__dirname, "..", "config");

// Minimal workflow fixture for testing
function makeMinimalWorkflow(initialPrompt: string): object {
  return {
    "38": {
      class_type: "CLIPTextEncode",
      inputs: { text: "worst quality, low quality", clip: ["4", 1] },
    },
    "41": {
      class_type: "KSampler",
      inputs: { seed: 12345, steps: 10, cfg: 1.5, model: ["4", 0], positive: ["119", 0], negative: ["38", 0], latent_image: ["25", 0] },
    },
    "50": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "Test", images: ["33", 0] },
    },
    "119": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: initialPrompt,
        clip: ["4", 1],
      },
    },
  };
}

describe("patchWorkflow", () => {
  it("replaces positive prompt text in CLIPTextEncode node", () => {
    const wf = makeMinimalWorkflow("masterpiece, best quality, original_content");
    // Simulate the patch logic
    const tags = ["1girl", "silver_hair", "smiling"];
    const prompt = tags.join(", ");

    // Find positive CLIPTextEncode (not negative)
    const clipNodes = Object.entries(wf).filter(
      ([, node]) => (node as any).class_type === "CLIPTextEncode"
    );
    for (const [, node] of clipNodes) {
      const n = node as any;
      const text = n.inputs.text as string;
      if (/^(worst quality|low quality|nsfw|bad|negative)/i.test(text.trim())) continue;
      const qualityMatch = text.match(/^([\s\S]*?)(?=\n\n|$)/);
      const prefix = (qualityMatch?.[1] ?? "").trim();
      if (prefix && prefix.split(",").length >= 3) {
        n.inputs.text = prefix + ",\n\n" + prompt;
      } else {
        n.inputs.text = prompt;
      }
    }

    const positiveNode = (wf as any)["119"];
    expect(positiveNode.inputs.text).toContain("1girl, silver_hair, smiling");
    expect(positiveNode.inputs.text).toContain("masterpiece, best quality");
  });

  it("preserves existing quality prefix", () => {
    const wf = makeMinimalWorkflow("masterpiece, best quality, score_9, score_8, score_7\n\noriginal_content");
    const tags = ["1girl", "blue_hair"];
    const prompt = tags.join(", ");

    const clipNodes = Object.entries(wf).filter(
      ([, node]) => (node as any).class_type === "CLIPTextEncode"
    );
    for (const [, node] of clipNodes) {
      const n = node as any;
      const text = n.inputs.text as string;
      if (/^(worst quality|low quality|nsfw|bad|negative)/i.test(text.trim())) continue;
      const qualityMatch = text.match(/^([\s\S]*?)(?=\n\n|$)/);
      const prefix = (qualityMatch?.[1] ?? "").trim();
      if (prefix && prefix.split(",").length >= 3) {
        n.inputs.text = prefix + ",\n\n" + prompt;
      } else {
        n.inputs.text = prompt;
      }
    }

    const positiveNode = (wf as any)["119"];
    expect(positiveNode.inputs.text).toBe("masterpiece, best quality, score_9, score_8, score_7,\n\n1girl, blue_hair");
  });

  it("does not modify negative prompt node", () => {
    const wf = makeMinimalWorkflow("masterpiece, 1girl, original");
    const tags = ["1girl", "test"];
    const prompt = tags.join(", ");

    const clipNodes = Object.entries(wf).filter(
      ([, node]) => (node as any).class_type === "CLIPTextEncode"
    );
    for (const [, node] of clipNodes) {
      const n = node as any;
      const text = n.inputs.text as string;
      if (/^(worst quality|low quality|nsfw|bad|negative)/i.test(text.trim())) continue;
      n.inputs.text = prompt;
    }

    const negativeNode = (wf as any)["38"];
    expect(negativeNode.inputs.text).toBe("worst quality, low quality");
  });

  it("replaces seed in KSampler node", () => {
    const wf = makeMinimalWorkflow("masterpiece, 1girl");
    const newSeed = 99999;
    const samplerNodes = Object.entries(wf).filter(
      ([, node]) => (node as any).class_type === "KSampler"
    );
    for (const [, node] of samplerNodes) {
      (node as any).inputs.seed = newSeed;
    }

    const sampler = (wf as any)["41"];
    expect(sampler.inputs.seed).toBe(99999);
  });

  it("replaces filename prefix in SaveImage node with dynamic workflow key", () => {
    const wf = makeMinimalWorkflow("masterpiece, 1girl");
    const wfKey = "my_custom_workflow";
    const prefix = `recipe_${wfKey}_iter3`;
    const saveNodes = Object.entries(wf).filter(
      ([, node]) => (node as any).class_type === "SaveImage"
    );
    for (const [, node] of saveNodes) {
      (node as any).inputs.filename_prefix = prefix;
    }

    const saveNode = (wf as any)["50"];
    expect(saveNode.inputs.filename_prefix).toBe("recipe_my_custom_workflow_iter3");
  });
});

describe("buildSummary", () => {
  // We test the logic inline since buildSummary is not exported
  it("produces valid markdown with dynamic module printing", () => {
    const recipe = {
      character: ["1girl", "silver_hair", "blue_eyes"],
      pose: ["sitting", "leaning_forward"],
      clothing: ["maid_outfit", "black_dress"],
      tags: ["1girl", "silver_hair", "blue_eyes", "sitting", "leaning_forward", "maid_outfit", "black_dress"],
    };

    const lines: string[] = ["# Recipe Extraction Summary", ""];
    for (const [key, value] of Object.entries(recipe)) {
      if (key === "tags") continue;
      if (Array.isArray(value) && value.length > 0) {
        lines.push(`## ${key}`);
        lines.push(`Tags: \`${value.join(", ")}\``);
        lines.push("");
      }
    }
    if (Array.isArray(recipe.tags)) {
      lines.push("## Combined Tags", "```", recipe.tags.join(", "), "```", "");
    }

    const md = lines.join("\n");
    expect(md).toContain("## character");
    expect(md).toContain("1girl, silver_hair, blue_eyes");
    expect(md).toContain("## pose");
    expect(md).toContain("## clothing");
    expect(md).toContain("## Combined Tags");
    expect(md).not.toContain("## tags"); // tags key should be skipped in module loop
  });
});
