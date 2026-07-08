#!/usr/bin/env node
import {
  loadConfig,
  createLogger,
  EcsOrchestrator,
  TeardownScheduler,
  ResultsReader,
} from '@uncommon-carp/weir-core';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ verbose: config.verbose });
  const ecs = new EcsOrchestrator(config, logger);
  const scheduler = new TeardownScheduler(config, logger);
  const results = new ResultsReader(config, logger);

  logger.info(`run=${config.runId} target=${config.targetImageTag}`);
  logger.info('registering task definition revision...');
  const taskDefArn = await ecs.registerRevision();
  logger.info(`task def: ${taskDefArn}`);

  logger.info('launching scan task...');
  const taskArn = await ecs.runTask(taskDefArn);
  logger.info(`task launched: ${taskArn}`);

  await scheduler.create(taskArn);
  logger.info(`teardown backstop set at +${config.teardownMinutes}min`);

  let exitCode = 1;

  try {
    logger.info('waiting for scan to complete...');
    const runResult = await ecs.waitForCompletion(taskArn);
    logger.info(
      `task stopped — sentinel exit=${runResult.exitCode} reason=${runResult.stoppedReason ?? 'none'}`
    );

    const report = await results.read();
    const findingCount = report.findings?.length ?? 0;
    const suiteErrorCount = report.suiteErrors?.length ?? 0;

    if (suiteErrorCount > 0) {
      logger.warn(`${suiteErrorCount} suite error(s) — scan may be incomplete`);
      for (const e of report.suiteErrors) {
        logger.warn(`suite error: ${e.suite}: ${e.message}`);
      }
    }

    logger.info(`${findingCount} finding(s) — ${results.s3Uri()}`);
    for (const f of report.findings ?? []) {
      logger.info(`[${f.severity}] ${f.id}: ${f.title}`);
    }

    exitCode = findingCount > 0 ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error(`orchestrator error: ${message}`, stack ? { stack } : undefined);
    try { await ecs.stopTask(taskArn, 'weir: orchestrator error'); } catch { }
    exitCode = 1;
  } finally {
    try { await scheduler.cancel(); } catch { }
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error('[weir] fatal:', err);
  process.exit(1);
});
