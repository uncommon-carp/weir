#!/usr/bin/env node
import {
  loadConfig,
  EcsOrchestrator,
  TeardownScheduler,
  ResultsReader,
} from '@uncommon-carp/weir-core';

async function main(): Promise<void> {
  const config = loadConfig();
  const ecs = new EcsOrchestrator(config);
  const scheduler = new TeardownScheduler(config);
  const results = new ResultsReader(config);

  console.log(`[weir] run=${config.runId} target=${config.targetImageTag}`);
  console.log('[weir] registering task definition revision...');
  const taskDefArn = await ecs.registerRevision();
  console.log(`[weir] task def: ${taskDefArn}`);

  console.log('[weir] launching scan task...');
  const taskArn = await ecs.runTask(taskDefArn);
  console.log(`[weir] task launched: ${taskArn}`);

  await scheduler.create(taskArn);
  console.log(`[weir] teardown backstop set at +${config.teardownMinutes}min`);

  let exitCode = 1;

  try {
    console.log('[weir] waiting for scan to complete...');
    const runResult = await ecs.waitForCompletion(taskArn);
    console.log(
      `[weir] task stopped — sentinel exit=${runResult.exitCode} reason=${runResult.stoppedReason ?? 'none'}`
    );

    const report = await results.read();
    const findingCount = report.findings?.length ?? 0;
    const suiteErrorCount = report.suiteErrors?.length ?? 0;

    if (suiteErrorCount > 0) {
      console.warn(`\n[weir] warning: ${suiteErrorCount} suite error(s) — scan may be incomplete`);
      for (const e of report.suiteErrors) {
        console.warn(`  [suite error] ${e.suite}: ${e.message}`);
      }
    }

    console.log(`\n[weir] ${findingCount} finding(s) — ${results.s3Uri()}\n`);
    for (const f of report.findings ?? []) {
      console.log(`  [${f.severity}] ${f.id}: ${f.title}`);
    }

    exitCode = findingCount > 0 ? 1 : 0;
  } catch (err) {
    console.error('[weir] error:', err);
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
