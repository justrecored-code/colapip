// ============================================================================
// Recipe Engine Plugin — extracts modular tags from images via ComfyUI + audit
// ============================================================================

import type { Plugin, PluginConfig, PluginContext, Task, TaskResult } from "../../src/core/plugin.js";
import type { LLMAdapter } from "../../src/core/llm.js";
import { ROOT } from "../../src/core/config.js";
import { createAgentModel } from "../../src/core/llm.js";
import { updateTaskState } from "../../src/core/db.js";
import { ERR_SERVICE_DOWN, ERR_TIMEOUT, errMsg } from "../../src/core/error-codes.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import fs from "fs-extra";
import path from "path";


// ============================================================================
// Plugin state
// ============================================================================

let _status: "idle" | "running" | "error" | "paused" = "idle";
let _rootDir: string;
let _logStream: ReturnType<typeof fs.createWriteStream> | null = null;

function initLog(): void {
  const p = path.join(ROOT, "logs", "recipe-engine");
  fs.ensureDirSync(p);
  _logStream = fs.createWriteStream(path.join(p, "engine.log"), { flags: "a" });
}
function plog(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  _logStream?.write(`[${ts}] ${msg}\n`);
}

// ============================================================================
// ComfyUI paths
// ============================================================================

const COMFYUI_URL = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const GEN_TIMEOUT_MS = 10 * 60 * 1000;

// ============================================================================
// ComfyUI client (same as original, but using ctx paths)
// ============================================================================

async function queuePrompt(workflow: object): Promise<string> {
  try {
    const resp = await fetch(`${COMFYUI_URL}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: "recipe-engine" }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) throw new Error(`ComfyUI returned ${resp.status}`);
    const data = await resp.json() as { prompt_id: string };
    return data.prompt_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("abort")) throw new Error(errMsg(ERR_TIMEOUT, "ComfyUI 请求超时"));
    if (msg.includes("503") || msg.includes("502") || msg.includes("ECONNREFUSED")) throw new Error(errMsg(ERR_SERVICE_DOWN, "ComfyUI 不可用"));
    throw new Error(errMsg(ERR_SERVICE_DOWN, msg));
  }
}

async function waitForResult(promptId: string): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < GEN_TIMEOUT_MS) {
    const resp = await fetch(`${COMFYUI_URL}/history/${promptId}`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) { await sleep(1000); continue; }
    const data = await resp.json() as Record<string, unknown>;
    if (data[promptId]) {
      const outputs = data[promptId] as { outputs: Record<string, { images: Array<{ filename: string }> }> };
      const images: string[] = [];
      for (const nodeOutput of Object.values(outputs.outputs)) {
        for (const img of nodeOutput.images ?? []) images.push(img.filename);
      }
      if (images.length > 0) return images;
    }
    await sleep(2000);
  }
  throw new Error(errMsg(ERR_TIMEOUT, "ComfyUI 生图超时"));
}

async function getImage(filename: string): Promise<Buffer> {
  const resp = await fetch(`${COMFYUI_URL}/view?filename=${filename}`);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// Workflow discovery + patch
// ============================================================================

type WorkflowNode = { inputs: Record<string, unknown>; class_type: string };
type WorkflowGraph = Record<string, WorkflowNode>;

interface WorkflowDef { key: string; file: string; modes?: string[]; }

function discoverWorkflows(mode?: string): Record<string, string> {
  const pconfigPath = path.join(_rootDir, "plugin.json");
  if (!fs.existsSync(pconfigPath)) return {};
  const pconfig = fs.readJSONSync(pconfigPath) as { workflows?: WorkflowDef[] };
  const result: Record<string, string> = {};
  for (const wf of pconfig.workflows ?? []) {
    if (mode && wf.modes && !wf.modes.includes(mode)) continue;
    const fp = path.join(_rootDir, wf.file);
    if (fs.existsSync(fp)) result[wf.key] = fp;
  }
  return result;
}

function loadWorkflow(filePath: string): WorkflowGraph {
  return fs.readJSONSync(filePath) as WorkflowGraph;
}

function patchWorkflow(base: WorkflowGraph, positiveTags: string[], seed: number, iteration: number, wfKey: string): WorkflowGraph {
  const workflow: WorkflowGraph = JSON.parse(JSON.stringify(base));
  const positivePrompt = positiveTags.join(", ");

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node.class_type === "CLIPTextEncode") {
      // Skip widget references (text connected from another node, e.g. ["89", 0])
      if (typeof node.inputs.text !== "string") continue;
      const text: string = node.inputs.text;
      const isNegative = /^(worst quality|low quality|nsfw|bad|negative)/i.test(text.trim())
        || /negative/i.test(((node as any)._meta?.title as string) || "");
      if (!isNegative) {
        const qualityMatch = text.match(/^([\s\S]*?)(?=\n\n|$)/);
        const existingPrefix = (qualityMatch?.[1] ?? "").trim();
        node.inputs.text = (existingPrefix && existingPrefix.split(",").length >= 3)
          ? existingPrefix + ",\n\n" + positivePrompt
          : positivePrompt;
      }
    }
    if (node.class_type === "KSampler") {
      node.inputs.seed = seed;
    }
    if (node.class_type === "SaveImage") {
      node.inputs.filename_prefix = `recipe_${wfKey}_iter${iteration}`;
    }
  }
  return workflow;
}

// ============================================================================
// Audit (same as original independent audit)
// ============================================================================

async function runAudit(
  originalPath: string, generatedPaths: Record<string, string>,
  llm: LLMAdapter, iteration: number,
): Promise<string> {
  const origB64 = fs.readFileSync(originalPath).toString("base64");
  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${origB64}` } },
    { type: "text", text: "↑ ORIGINAL. Below are generated:" },
  ];
  for (const [key, imgPath] of Object.entries(generatedPaths)) {
    if (!fs.existsSync(imgPath)) continue;
    const b64 = fs.readFileSync(imgPath).toString("base64");
    content.push(
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      { type: "text", text: `↑ ${key}` },
    );
  }
  content.push({
    type: "text",
    text: `Art direction feedback. Compare each generated image to original. Creative direction, not tag fixes. What works, what could be bolder. No scores.`,
  });

  const result = await llm.chat({ messages: [{ role: "user", content }], maxTokens: 1500 });
  return result.content;
}

/** Prompt → Generate → Save (single pass, no iteration needed) */
async function processGeneration(promptText: string, task: { id: string; params: Record<string, unknown> }, ctx: PluginContext, _maxIterations: number): Promise<TaskResult> {
  const wfKeys = Object.keys(discoverWorkflows("generate"));
  if (wfKeys.length === 0) return { success: false, error: "No ComfyUI workflows found" };

  const runId = "gen-" + Date.now();
  const outputDir = path.join(ROOT, "data", "assets", "recipes", runId);
  fs.ensureDirSync(outputDir);
  const seed = 42;
  ctx.logger.info(`Prompt generation: "${promptText.slice(0, 60)}"`);
  ctx.eventBus.emit("task.progress", { taskId: task.id, progress: 0, step: "generating" });

  const bestResults: Record<string, { seed: number; path: string }> = {};
  const tags = promptText.split(",").map(t => t.trim()).filter(Boolean);

  for (const wfKey of wfKeys) {
    try {
      const wfFile = discoverWorkflows()[wfKey]!;
      const patched = patchWorkflow(loadWorkflow(wfFile), tags, seed, 1, wfKey);
      const promptId = await queuePrompt(patched);
      const filenames = await waitForResult(promptId);
      const filename = filenames[0];
      if (!filename) throw new Error(errMsg(ERR_SERVICE_DOWN, "ComfyUI 无输出"));
      const buffer = await getImage(filename);
      const imgPath = path.join(outputDir, `gen_${wfKey}.png`);
      fs.writeFileSync(imgPath, buffer);
      bestResults[wfKey] = { seed, path: imgPath };
      ctx.createAsset(task.id, "image/png", imgPath, `gen_${wfKey}.png`, buffer.length, { wfKey, seed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.eventBus.emit("task.error", { taskId: task.id, errorCode: ERR_SERVICE_DOWN, rawError: msg, pluginName: "recipe-engine" });
      ctx.logger.error(`[${wfKey}] ${msg}`);
    }
  }

  // Save recipe
  const recipe = { prompt: promptText, seed, best_paths: Object.fromEntries(Object.entries(bestResults).map(([k, v]) => [k, v.path])), generated_at: new Date().toISOString() };
  fs.writeJSONSync(path.join(outputDir, "recipe.json"), recipe, { spaces: 2 });
  ctx.createAsset(task.id, "application/json", path.join(outputDir, "recipe.json"), "recipe.json", fs.statSync(path.join(outputDir, "recipe.json")).size);
  ctx.eventBus.emit("task.progress", { taskId: task.id, progress: 1, step: "done" });
  const imagePaths = Object.values(bestResults).map(r => r.path);
  return { success: true, data: { runId, mode: "generate", outputDir, images: imagePaths } };
}

// ============================================================================
// Plugin implementation
// ============================================================================

const recipeEnginePlugin: Plugin = {
  name: "recipe-engine",
  version: "1.0.0",
  description: "图片反推标签 — ComfyUI 生成 + 独立审计迭代",
  usesPiAgent: true,
  skills: [],
  ownSkills: [],

  async init(config: PluginConfig) {
    _rootDir = config.rootDir;
    initLog();
  },

  async start() { _status = "idle"; },
  async stop() { _status = "idle"; },
  getStatus() { return _status; },

  async execute(task: Task, ctx: PluginContext): Promise<TaskResult> {
    _status = "running";
    const mode = (task.params.mode as string) || (task.params.prompt ? "generate" : "extract");
    const promptText = (task.params.prompt as string) || "";
    const image = (task.params.image || task.params.image_path) as string;
    const maxIterations = (task.params.max_iterations as number) ?? (mode === "generate" ? 1 : 3);

    // ── generate mode: prompt text → generate ──
    if (mode === "generate" || promptText) {
      if (!promptText) { _status = "error"; return { success: false, error: "缺少 prompt 参数。提供提示词，英文逗号分隔。" }; }
      ctx.logger.info(`Prompt mode: "${promptText.slice(0, 80)}"`);
      return await processGeneration(promptText, task, ctx, maxIterations);
    }

    // ── extract mode: image → VLM tags → generate ──
    const rawDir = path.join(ROOT, "data", "x-scrape");
    let imagePaths: string[];

    if (!image) {
      _status = "error";
      return { success: false, error: "缺少 image 参数。提供文件路径、文件名或 'all' 批量处理。" };
    }

    if (image === "all" || image === "batch") {
      imagePaths = fs.readdirSync(rawDir)
        .filter(f => f.endsWith(".jpg") || f.endsWith(".png"))
        .map(f => path.join(rawDir, f));
      if (imagePaths.length === 0) {
        _status = "error";
        return { success: false, error: "中没有图片" };
      }
      plog(`Batch mode: ${imagePaths.length} images`);
    } else if (fs.existsSync(image)) {
      imagePaths = [image];
    } else if (fs.existsSync(path.join(rawDir, image))) {
      imagePaths = [path.join(rawDir, image)];
    } else {
      _status = "error";
      const files = fs.readdirSync(rawDir).filter(f => f.endsWith(".jpg") || f.endsWith(".png")).slice(0, 10);
      return { success: false, error: `未找到图片 "${image}"。图片目录中部分文件: ${files.join(", ")}` };
    }

    // Shared setup (discover workflows once)
    const wfKeys = Object.keys(discoverWorkflows(mode));
    if (wfKeys.length === 0) {
      _status = "error";
      return { success: false, error: "No ComfyUI workflows found in config/" };
    }

    const systemPromptPath = path.join(_rootDir, "system-prompt.md");
    if (!fs.existsSync(systemPromptPath)) {
      _status = "error";
      return { success: false, error: "System prompt not found" };
    }
    const systemPrompt = fs.readFileSync(systemPromptPath, "utf-8");

    // ── Shared Agent for the entire batch ──
    const agent = new Agent({
      initialState: { systemPrompt, model: createAgentModel({ name: "Platform LLM", supportsImages: true }), thinkingLevel: "high" },
      toolExecution: "sequential",
      getApiKey: async () => "not-needed",
    });

    // Per-image mutable state (agent tools close over these)
    let currentImagePath = "";
    let currentOutputDir = "";
    let currentBestResults: Record<string, { seed: number; path: string }> = {};
    let iterationCount = 0;
    let seed = 42;

    agent.state.tools = [
    {
      name: "generate_image", label: `Generate`,
      description: `Generate from all workflows. Provide tags_<workflow_key> for each workflow. Returns images + audit.`,
      parameters: buildGenerateParams(wfKeys),
      execute: async (_tid: string, rawParams: unknown) => {
        const params = rawParams as Record<string, unknown>;
        if (iterationCount >= maxIterations) {
          return { content: [{ type: "text", text: "Max iterations. Call save_recipe." }], details: {} };
        }
        iterationCount++;
        seed = (params.seed as number) ?? seed;

        plog(`Iteration ${iterationCount}, seed ${seed}`);
        // Only update step text — batch position progress is managed by the outer loop
        ctx.eventBus.emit("task.progress", {
          taskId: task.id,
          step: `generating_iter${iterationCount}`,
        });

        const paths: Record<string, string> = {};
        const contentBlocks: Array<any> = [];

        for (const wfKey of wfKeys) {
          try {
          const tags = (params[`tags_${wfKey}`] as string[]) ?? [];
          const wfFile = discoverWorkflows()[wfKey]!;
          const patched = patchWorkflow(loadWorkflow(wfFile), tags, seed, iterationCount, wfKey);

          const promptId = await queuePrompt(patched);
          const filenames = await waitForResult(promptId);
          const filename = filenames[0];
          if (!filename) throw new Error(errMsg(ERR_SERVICE_DOWN, `[${wfKey}] ComfyUI 无输出`));
          const buffer = await getImage(filename);

          const imgPath = path.join(currentOutputDir, `gen_iter${iterationCount}_seed${seed}_${wfKey}.png`);
          fs.writeFileSync(imgPath, buffer);
          currentBestResults[wfKey] = { seed, path: imgPath };
          paths[wfKey] = imgPath;

          contentBlocks.push(
            { type: "text", text: `[${wfKey}] ✓ tags: ${tags.join(", ")}` },
            { type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
          );
          ctx.createAsset(task.id, "image/png", imgPath, `gen_iter${iterationCount}_seed${seed}_${wfKey}.png`, buffer.length, { wfKey, iteration: iterationCount, seed });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const errorCode = msg.startsWith("ERR_") ? msg.split(":")[0]! : ERR_SERVICE_DOWN;
            ctx.eventBus.emit("task.error", { taskId: task.id, errorCode, rawError: msg, pluginName: "recipe-engine" });
            plog(`[${wfKey}] ${msg}`);
            contentBlocks.push({ type: "text", text: `[${wfKey}] FAILED: ${msg}` });
          }
        }

        // Audit
        const auditText = await runAudit(currentImagePath, paths, ctx.llm, iterationCount);
        const auditPath = path.join(currentOutputDir, `audit_iter${iterationCount}.md`);
        fs.writeFileSync(auditPath, auditText, "utf-8");
        ctx.createAsset(task.id, "text/markdown", auditPath, `audit_iter${iterationCount}.md`, auditText.length, { iteration: iterationCount });

        contentBlocks.unshift({ type: "text", text: `Iter ${iterationCount} (seed ${seed}): ${auditText}` });
        return { content: contentBlocks, details: { seed, iteration: iterationCount } };
      },
    },
    {
      name: "save_recipe", label: "Save",
      description: "Save recipe. summary=中文描述+迭代日记+对比.",
      parameters: Type.Object({
        recipe: Type.Object({}),
        best_seed: Type.Number(),
        iterations: Type.Number(),
        summary: Type.String(),
      }),
      execute: async (_tid: string, rawParams: unknown) => {
        const p = rawParams as Record<string, unknown>;
        const recipe = p.recipe as Record<string, unknown>;
        const bestSeed = p.best_seed as number;
        const iters = p.iterations as number;
        const summary = (p.summary as string) ?? "";

        // Store the prompts used in each iteration
        const iterations: Array<{ iteration: number; seed: number; tags: Record<string, string[]> }> = [];
        for (const [wfKey] of Object.entries(currentBestResults)) {
          // Tags are stored per iteration from the agent's calls — simplified: store best
        }

        const output = {
          image: path.basename(currentImagePath),
          recipe,
          best_seed: bestSeed,
          best_paths: Object.fromEntries(Object.entries(currentBestResults).map(([k, v]) => [k, v.path])),
          iterations: iters,
          generated_at: new Date().toISOString(),
        };

        const recipePath = path.join(currentOutputDir, "recipe.json");
        fs.writeJSONSync(recipePath, output, { spaces: 2 });
        ctx.createAsset(task.id, "application/json", recipePath, "recipe.json", fs.statSync(recipePath).size);

        const summaryPath = path.join(currentOutputDir, "summary.md");
        fs.writeFileSync(summaryPath, `# ${path.basename(currentImagePath)}\n\n${summary}`, "utf-8");
        ctx.createAsset(task.id, "text/markdown", summaryPath, "summary.md", fs.statSync(summaryPath).size);

        return { content: [{ type: "text", text: `Saved: ${recipePath}` }], details: {}, terminate: true };
      },
    },
    ];

    // ── Process each image ──
    const results: string[] = [];
    const total = imagePaths.length;
    const resumeIdx = (task.params._resumeIdx as number) ?? 0;
    const imgShare = 1 / total;

    for (let idx = resumeIdx; idx < imagePaths.length; idx++) {
      const imagePath = imagePaths[idx]!;
      const imageName = path.basename(imagePath);
      const batchPrefix = total > 1 ? `[${idx + 1}/${total}] ` : "";
      const baseProgress = idx / total;

      currentImagePath = imagePath;
      currentOutputDir = path.join(ROOT, "data", "assets", "recipes", "recipe-" + Date.now());
      currentBestResults = {};
      iterationCount = 0;
      seed = 42;

      plog(`${batchPrefix}Processing: ${imageName}`);
      ctx.eventBus.emit("task.progress", { taskId: task.id, progress: baseProgress, step: `${batchPrefix}${imageName}` });

      fs.ensureDirSync(currentOutputDir);
      fs.copyFileSync(imagePath, path.join(currentOutputDir, "original.png"));

      const imageBuf = await fs.readFile(imagePath);
      const imageB64 = imageBuf.toString("base64");

      ctx.eventBus.emit("task.progress", {
        taskId: task.id,
        progress: baseProgress + imgShare * 0.05,
        step: `${batchPrefix}extracting_tags`,
      });

      await agent.prompt(
        `Image ${idx + 1}/${total}: Extract modular tags. Workflows: ${wfKeys.join(", ")}. For each, call generate_image with tags_<key>. Iterate to improve, then save_recipe.`,
        [{ type: "image", data: imageB64, mimeType: path.extname(imagePath).toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg" }],
      );
      await agent.waitForIdle();

      // FollowUp if agent didn't save
      const recipePath = path.join(currentOutputDir, "recipe.json");
      if (!fs.existsSync(recipePath)) {
        agent.followUp({ role: "user", content: "Call save_recipe NOW with summary + best_seed + recipe." } as any);
        await agent.continue();
        await agent.waitForIdle();
      }

      results.push(currentOutputDir);
      plog(`${batchPrefix}Done: ${imageName}`);
      ctx.eventBus.emit("task.progress", { taskId: task.id, progress: (idx + 1) / total, step: `${batchPrefix}done` });

      // Clear agent context for next image (keep tools, reset messages)
      agent.state.messages = [];

      if (ctx.aborted) {
        plog(`Cancelled after ${idx + 1}/${total}`);
        _status = "idle";
        return { success: false, error: "cancelled" };
      }

      if (total > 1 && idx + 1 < total) {
        updateTaskState(task.id, "running", { checkpoint: { idx: idx + 1, maxIterations } });
      }
    }

    _status = "idle";
    ctx.eventBus.emit("task.progress", { taskId: task.id, progress: 1, step: `done (${total} images)` });
    return { success: true, data: { runs: results, total: results.length } };
  },

  async resume(taskId: string, checkpoint: unknown, ctx: PluginContext): Promise<void> {
    const cp = (checkpoint && typeof checkpoint === "object") ? checkpoint as Record<string, unknown> : null;
    // If checkpoint has an idx, skip ahead in batch mode
    if (cp?.idx != null && typeof cp.idx === "number") {
      const task: Task = { id: taskId, pluginName: "recipe-engine", params: { image: "all", max_iterations: cp.maxIterations ?? 3 } };
      // Pass checkpoint idx so execute() can skip first N images
      await this.execute({ ...task, params: { ...task.params, _resumeIdx: cp.idx } }, ctx);
    } else {
      const task: Task = { id: taskId, pluginName: "recipe-engine", params: (cp?.params as Record<string, unknown>) ?? {} };
      await this.execute(task, ctx);
    }
  },
};

export default recipeEnginePlugin;

// ============================================================================
// Helpers
// ============================================================================

function buildGenerateParams(wfKeys: string[]) {
  const props: Record<string, any> = {
    seed: Type.Optional(Type.Number()),
    iteration: Type.Number(),
  };
  for (const key of wfKeys) props[`tags_${key}`] = Type.Array(Type.String());
  return Type.Object(props);
}
