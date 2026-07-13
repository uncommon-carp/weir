import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ECSClient, ListTasksCommand, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import type { Logger } from '../src/logger.js';
import type { Config } from '../src/config.js';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecs')>();
  return {
    ...actual,
    ECSClient: vi.fn(),
  };
});

const { EcsOrchestrator } = await import('../src/ecs.js');

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

describe('EcsOrchestrator.runTask concurrency', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // The global restoreMocks/mockReset config wipes this constructor
    // mock's implementation between tests too — re-arm it every time.
    vi.mocked(ECSClient).mockImplementation(function () {
      return { send: mockSend } as unknown as ECSClient;
    });
  });

  it('launches normally when the post-launch recount is still within the cap', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ListTasksCommand) return Promise.resolve({ taskArns: [] });
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({ tasks: [{ taskArn: 'arn:task:1' }] });
      }
      throw new Error(`unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    });

    const ecs = new EcsOrchestrator(baseConfig({ maxConcurrentScans: 2 }), silentLogger());
    const taskArn = await ecs.runTask('arn:taskdef:1');

    expect(taskArn).toBe('arn:task:1');
    expect(mockSend.mock.calls.some(([cmd]) => cmd instanceof StopTaskCommand)).toBe(false);
  });

  it('self-corrects: stops the task it just launched if a concurrent launch races it past the cap', async () => {
    // Simulates the TOCTOU window: countActiveTasks() (pre-launch) sees room,
    // RunTaskCommand succeeds, but by the time we recount, a concurrent
    // runTask() call (a separate CI job) has also landed a task.
    let launched = false;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ListTasksCommand) {
        if (command.input.desiredStatus !== 'RUNNING') return Promise.resolve({ taskArns: [] });
        return Promise.resolve({ taskArns: launched ? ['arn:task:1', 'arn:task:2'] : [] });
      }
      if (command instanceof RunTaskCommand) {
        launched = true;
        return Promise.resolve({ tasks: [{ taskArn: 'arn:task:1' }] });
      }
      if (command instanceof StopTaskCommand) return Promise.resolve({});
      throw new Error(`unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    });

    const ecs = new EcsOrchestrator(baseConfig({ maxConcurrentScans: 1 }), silentLogger());

    await expect(ecs.runTask('arn:taskdef:1')).rejects.toThrow(/race detected/);

    const stopCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof StopTaskCommand);
    expect(stopCalls).toHaveLength(1);
    expect((stopCalls[0][0] as StopTaskCommand).input).toMatchObject({
      cluster: 'weir-cluster',
      task: 'arn:task:1',
    });
  });

  it('never calls RunTask at all if the pre-launch count is already at the cap', async () => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof ListTasksCommand) {
        if (command.input.desiredStatus !== 'RUNNING') return Promise.resolve({ taskArns: [] });
        return Promise.resolve({ taskArns: ['arn:task:existing'] });
      }
      throw new Error(`unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
    });

    const ecs = new EcsOrchestrator(baseConfig({ maxConcurrentScans: 1 }), silentLogger());

    await expect(ecs.runTask('arn:taskdef:1')).rejects.toThrow(/Concurrency cap/);
    expect(mockSend.mock.calls.some(([cmd]) => cmd instanceof RunTaskCommand)).toBe(false);
  });
});

describe('EcsOrchestrator.registerRevision target env redaction', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.mocked(ECSClient).mockImplementation(function () {
      return { send: mockSend } as unknown as ECSClient;
    });
  });

  it('redacts secret-shaped WEIR_TARGET_ENV keys in the debug log but leaves ordinary flags visible', async () => {
    mockSend.mockResolvedValue({ taskDefinition: { taskDefinitionArn: 'arn:taskdef:1' } });
    const logger = silentLogger();
    const ecs = new EcsOrchestrator(
      baseConfig({
        targetEnvOverrides: { AUTH_REQUIRED: 'true', API_KEY: 'sk-live-secret', DB_PASSWORD: 'hunter2' },
      }),
      logger
    );

    await ecs.registerRevision();

    const debugCall = (logger.debug as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, data]) => (data as { event?: string })?.event === 'weir.target.env.override'
    );
    expect(debugCall).toBeDefined();
    const overrides = (debugCall![1] as { overrides: Record<string, string> }).overrides;
    expect(overrides).toEqual({
      AUTH_REQUIRED: 'true',
      API_KEY: '***',
      DB_PASSWORD: '***',
    });
  });
});
