import { describe, it, expect, vi } from 'vitest';
import type { Logger, ScanReport } from '@uncommon-carp/weir-core';
import {
  runScan,
  type ScanEcs,
  type ScanScheduler,
  type ScanResults,
  type ScanRunConfig,
} from '../src/run-scan.js';

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function emptyReport(): ScanReport {
  return {
    meta: { startedAt: '2026-01-01T00:00:00Z', targetBaseUrl: 'http://localhost:3000', version: '0.0.0' },
    config: {},
    findings: [],
    suiteErrors: [],
    reporterErrors: [],
  };
}

const config: ScanRunConfig = {
  runId: 'weir-test-1',
  targetImageTag: 'abc123',
  teardownMinutes: 20,
};

describe('runScan', () => {
  it('registers, launches, arms the backstop, waits, and exits 0 on a clean report', async () => {
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockResolvedValue('arn:taskdef:1'),
      runTask: vi.fn().mockResolvedValue('arn:task:1'),
      waitForCompletion: vi.fn().mockResolvedValue({ taskArn: 'arn:task:1', exitCode: 0, stoppedReason: undefined }),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler: ScanScheduler = {
      create: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const results: ScanResults = {
      read: vi.fn().mockResolvedValue(emptyReport()),
      s3Uri: vi.fn().mockReturnValue('s3://bucket/results/weir-test-1.json'),
    };

    const exitCode = await runScan(ecs, scheduler, results, config, silentLogger());

    expect(exitCode).toBe(0);
    expect(scheduler.create).toHaveBeenCalledWith('arn:task:1');
    expect(scheduler.cancel).toHaveBeenCalledOnce();
    expect(ecs.stopTask).not.toHaveBeenCalled();
  });

  it('exits 1 when findings are present', async () => {
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockResolvedValue('arn:taskdef:1'),
      runTask: vi.fn().mockResolvedValue('arn:task:1'),
      waitForCompletion: vi.fn().mockResolvedValue({ taskArn: 'arn:task:1', exitCode: 2, stoppedReason: undefined }),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler: ScanScheduler = {
      create: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const report = emptyReport();
    report.findings = [{ id: 'headers.missing_hsts', severity: 'low', title: 'Missing HSTS' }];
    const results: ScanResults = {
      read: vi.fn().mockResolvedValue(report),
      s3Uri: vi.fn().mockReturnValue('s3://bucket/results/weir-test-1.json'),
    };

    const exitCode = await runScan(ecs, scheduler, results, config, silentLogger());

    expect(exitCode).toBe(1);
    expect(ecs.stopTask).not.toHaveBeenCalled();
  });

  it('never launches a task and never touches the scheduler if registerRevision fails', async () => {
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockRejectedValue(new Error('RegisterTaskDefinition denied')),
      runTask: vi.fn(),
      waitForCompletion: vi.fn(),
      stopTask: vi.fn(),
    };
    const scheduler: ScanScheduler = { create: vi.fn(), cancel: vi.fn() };
    const results: ScanResults = { read: vi.fn(), s3Uri: vi.fn() };

    await expect(runScan(ecs, scheduler, results, config, silentLogger())).rejects.toThrow(
      'RegisterTaskDefinition denied'
    );

    expect(ecs.runTask).not.toHaveBeenCalled();
    expect(scheduler.create).not.toHaveBeenCalled();
    expect(ecs.stopTask).not.toHaveBeenCalled();
  });

  it('regression (7.4): stops the task if the teardown backstop fails to schedule after launch', async () => {
    // This is the exact bug the review flagged: registerRevision and runTask
    // both succeed (a real, live Fargate task exists), then scheduler.create
    // throws. Before the fix, that throw happened outside any try/catch, so
    // it propagated straight past stopTask and left the task running with no
    // backstop armed at all.
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockResolvedValue('arn:taskdef:1'),
      runTask: vi.fn().mockResolvedValue('arn:task:1'),
      waitForCompletion: vi.fn(),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler: ScanScheduler = {
      create: vi.fn().mockRejectedValue(new Error('CreateSchedule throttled')),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const results: ScanResults = { read: vi.fn(), s3Uri: vi.fn() };

    const exitCode = await runScan(ecs, scheduler, results, config, silentLogger());

    expect(exitCode).toBe(1);
    expect(ecs.stopTask).toHaveBeenCalledWith('arn:task:1', expect.any(String));
    expect(scheduler.cancel).toHaveBeenCalledOnce();
    expect(ecs.waitForCompletion).not.toHaveBeenCalled();
  });

  it('stops the task and still cancels the backstop if waitForCompletion fails', async () => {
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockResolvedValue('arn:taskdef:1'),
      runTask: vi.fn().mockResolvedValue('arn:task:1'),
      waitForCompletion: vi.fn().mockRejectedValue(new Error('Timed out waiting for task')),
      stopTask: vi.fn().mockResolvedValue(undefined),
    };
    const scheduler: ScanScheduler = {
      create: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const results: ScanResults = { read: vi.fn(), s3Uri: vi.fn() };

    const exitCode = await runScan(ecs, scheduler, results, config, silentLogger());

    expect(exitCode).toBe(1);
    expect(ecs.stopTask).toHaveBeenCalledWith('arn:task:1', expect.any(String));
    expect(scheduler.cancel).toHaveBeenCalledOnce();
  });

  it('does not let a stopTask failure during cleanup mask the original error path', async () => {
    const ecs: ScanEcs = {
      registerRevision: vi.fn().mockResolvedValue('arn:taskdef:1'),
      runTask: vi.fn().mockResolvedValue('arn:task:1'),
      waitForCompletion: vi.fn().mockRejectedValue(new Error('Timed out waiting for task')),
      stopTask: vi.fn().mockRejectedValue(new Error('StopTask denied')),
    };
    const scheduler: ScanScheduler = {
      create: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const results: ScanResults = { read: vi.fn(), s3Uri: vi.fn() };

    const exitCode = await runScan(ecs, scheduler, results, config, silentLogger());

    expect(exitCode).toBe(1);
    expect(scheduler.cancel).toHaveBeenCalledOnce();
  });
});
