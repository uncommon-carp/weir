import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerClient, CreateScheduleCommand, DeleteScheduleCommand } from '@aws-sdk/client-scheduler';
import type { Logger } from '../src/logger.js';
import type { Config } from '../src/config.js';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-scheduler', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-scheduler')>();
  return {
    ...actual,
    SchedulerClient: vi.fn(),
  };
});

const { TeardownScheduler } = await import('../src/scheduler.js');

function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    region: 'us-east-2',
    ecsCluster: 'weir-cluster',
    taskFamily: 'weir-scan',
    subnetIds: ['subnet-1'],
    securityGroupId: 'sg-1',
    resultsBucket: 'weir-results',
    executionRoleArn: 'arn:aws:iam::123:role/exec',
    taskRoleArn: 'arn:aws:iam::123:role/task',
    schedulerRoleArn: 'arn:aws:iam::123:role/scheduler',
    ecrTargetRepo: '123.dkr.ecr.us-east-2.amazonaws.com/target',
    ecrSentinelRepo: '123.dkr.ecr.us-east-2.amazonaws.com/sentinel',
    logGroupName: '/weir/ci',
    maxConcurrentScans: 1,
    teardownMinutes: 20,
    targetPort: 3000,
    targetHealthCheckPath: '/api/v2/health',
    targetImageTag: 'abc123',
    runId: 'weir-test-1',
    verbose: false,
    targetEnvOverrides: {},
    targetAuthUrl: undefined,
    ...overrides,
  };
}

describe('TeardownScheduler', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // The global restoreMocks/mockReset config wipes this constructor
    // mock's implementation between tests too — re-arm it every time.
    vi.mocked(SchedulerClient).mockImplementation(function () {
      return { send: mockSend } as unknown as SchedulerClient;
    });
  });

  it('names the schedule after runId and targets the task/cluster/role from config', async () => {
    mockSend.mockResolvedValue({});
    const config = baseConfig({ runId: 'weir-run-42', teardownMinutes: 15 });
    const scheduler = new TeardownScheduler(config, silentLogger());

    await scheduler.create('arn:task:1');

    expect(mockSend).toHaveBeenCalledOnce();
    const command = mockSend.mock.calls[0][0] as CreateScheduleCommand;
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input.Name).toBe('weir-run-42');
    expect(command.input.Target?.RoleArn).toBe(config.schedulerRoleArn);
    expect(command.input.Target?.Input).toContain('"Cluster":"weir-cluster"');
    expect(command.input.Target?.Input).toContain('"Task":"arn:task:1"');
  });

  it('cancel() deletes the schedule named after runId', async () => {
    mockSend.mockResolvedValue({});
    const config = baseConfig({ runId: 'weir-run-42' });
    const scheduler = new TeardownScheduler(config, silentLogger());

    await scheduler.cancel();

    const command = mockSend.mock.calls[0][0] as DeleteScheduleCommand;
    expect(command).toBeInstanceOf(DeleteScheduleCommand);
    expect(command.input.Name).toBe('weir-run-42');
  });

  it('cancel() swallows ResourceNotFoundException (schedule already gone)', async () => {
    const err = Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
    mockSend.mockRejectedValue(err);
    const scheduler = new TeardownScheduler(baseConfig(), silentLogger());

    await expect(scheduler.cancel()).resolves.toBeUndefined();
  });

  it('cancel() rethrows any other error instead of swallowing it', async () => {
    const err = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    mockSend.mockRejectedValue(err);
    const scheduler = new TeardownScheduler(baseConfig(), silentLogger());

    await expect(scheduler.cancel()).rejects.toThrow('throttled');
  });
});
