#!/usr/bin/env node
// ============================================================================
// ColaPip CLI
// ============================================================================

import { Command } from "commander";
import { loadConfig } from "./core/config.js";
import { initDB } from "./core/db.js";
import { setEventBus } from "./core/logger.js";
import { eventBus } from "./core/event-bus.js";
import { toolRegistry, pluginManager } from "./core/plugin-manager.js";
import { startDashboard } from "./dashboard/server.js";

const program = new Command();

program
  .name("colapip")
  .description("Local AI task server — plugin pipelines with checkpoint recovery")
  .version("0.3.0");

// Start platform
program
  .command("start")
  .description("Start platform: load plugins + launch Dashboard")
  .action(async () => {
    console.log("\n🥤 Starting ColaPip\n");

    setEventBus(eventBus); // Must be before initDB so first logs are captured

    const config = loadConfig();
    console.log(`   LLM: ${config.llm.model} @ ${config.llm.baseUrl}`);

    initDB();
    console.log("   DB: initialized");

    await toolRegistry.loadFromDir();
    console.log("   Tool Registry: loaded");

    startDashboard();

    await pluginManager.scanAndRegister();
    const plugins = pluginManager.getAllPlugins();
    console.log(`   Plugins: ${plugins.length} loaded (${plugins.map(p => p.name).join(", ") || "none"})`);

    pluginManager.cleanupOrphanTasks();

    await pluginManager.recoverTasks();
    console.log(`\n✅ Platform ready\n`);
  });

program.parse(process.argv);
