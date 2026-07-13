import { describe, it, expect, vi, beforeEach } from 'vitest';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Logger } from '../src/logger.js';
import type { Config } from '../src/config.js';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async importOriginal => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn(),
  };
});

const { ResultsReader } = await import('../src/results.js');

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

function fakeReport() {
  return {
    meta: { startedAt: '2026-01-01T00:00:00Z', targetBaseUrl: 'http://localhost:3000', version: '0.0.0' },
    config: {},
    findings: [],
    suiteErrors: [],
    reporterErrors: [],
  };
}

describe('ResultsReader', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // The global restoreMocks/mockReset config wipes this constructor
    // mock's implementation between tests too — re-arm it every time.
    vi.mocked(S3Client).mockImplementation(function () {
      return { send: mockSend } as unknown as S3Client;
    });
  });

  it('derives the S3 key and URI from resultsBucket + runId', () => {
    const config = baseConfig({ resultsBucket: 'weir-results-bucket', runId: 'weir-run-42' });
    const results = new ResultsReader(config, silentLogger());

    expect(results.s3Uri()).toBe('s3://weir-results-bucket/results/weir-run-42.json');
  });

  it('read() fetches from the derived bucket/key and parses the JSON body', async () => {
    const report = fakeReport();
    mockSend.mockResolvedValue({
      Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify(report)) },
    });
    const config = baseConfig({ resultsBucket: 'weir-results-bucket', runId: 'weir-run-42' });
    const results = new ResultsReader(config, silentLogger());

    const read = await results.read();

    expect(read).toEqual(report);
    const command = mockSend.mock.calls[0][0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'weir-results-bucket', Key: 'results/weir-run-42.json' });
  });

  it('read() throws if S3 returns no Body', async () => {
    mockSend.mockResolvedValue({ Body: undefined });
    const results = new ResultsReader(baseConfig({ runId: 'weir-run-42' }), silentLogger());

    await expect(results.read()).rejects.toThrow('weir-run-42.json');
  });
});
