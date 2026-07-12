#!/usr/bin/env node
import {
  loadConfig,
  createLogger,
  EcsOrchestrator,
  TeardownScheduler,
  ResultsReader,
} from '@uncommon-carp/weir-core';
import { runScan } from './run-scan.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ verbose: config.verbose });
  const ecs = new EcsOrchestrator(config, logger);
  const scheduler = new TeardownScheduler(config, logger);
  const results = new ResultsReader(config, logger);

  const exitCode = await runScan(ecs, scheduler, results, config, logger);
  process.exit(exitCode);
}

main().catch(err => {
  console.error('[weir] fatal:', err);
  process.exit(1);
});
