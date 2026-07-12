import type { Config, Logger, RunResult, ScanReport } from '@uncommon-carp/weir-core';

// Narrow interfaces (not the concrete classes) so runScan can be exercised
// with plain mocks in tests without constructing real AWS clients.
export interface ScanEcs {
  registerRevision(): Promise<string>;
  runTask(taskDefinitionArn: string): Promise<string>;
  waitForCompletion(taskArn: string): Promise<RunResult>;
  stopTask(taskArn: string, reason: string): Promise<void>;
}

export interface ScanScheduler {
  create(taskArn: string): Promise<void>;
  cancel(): Promise<void>;
}

export interface ScanResults {
  read(): Promise<ScanReport>;
  s3Uri(): string;
}

export type ScanRunConfig = Pick<Config, 'runId' | 'targetImageTag' | 'teardownMinutes'>;

// A task is only ever "live" (needs stopTask on failure) once runTask has
// returned an ARN. scheduler.create() runs inside the try/catch specifically
// so that if it throws, the catch block below still stops the task instead
// of leaving it running with no teardown backstop armed at all.
export async function runScan(
  ecs: ScanEcs,
  scheduler: ScanScheduler,
  results: ScanResults,
  config: ScanRunConfig,
  logger: Logger
): Promise<number> {
  logger.info(`run=${config.runId} target=${config.targetImageTag}`);
  logger.info('registering task definition revision...');
  const taskDefArn = await ecs.registerRevision();
  logger.info(`task def: ${taskDefArn}`);

  logger.info('launching scan task...');
  const taskArn = await ecs.runTask(taskDefArn);
  logger.info(`task launched: ${taskArn}`);

  let exitCode = 1;

  try {
    await scheduler.create(taskArn);
    logger.info(`teardown backstop set at +${config.teardownMinutes}min`);

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

  return exitCode;
}
