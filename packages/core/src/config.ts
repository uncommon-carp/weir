export interface Config {
  region: string;
  ecsCluster: string;
  taskFamily: string;
  subnetIds: string[];
  securityGroupId: string;
  resultsBucket: string;
  executionRoleArn: string;
  taskRoleArn: string;
  schedulerRoleArn: string;
  ecrTargetRepo: string;
  ecrSentinelRepo: string;
  logGroupName: string;
  maxConcurrentScans: number;
  teardownMinutes: number;
  // Per-run, injected by the CLI from GHA context
  targetImageTag: string;
  runId: string;
  verbose: boolean;
  targetEnvOverrides: Record<string, string>;
  targetAuthUrl: string | undefined;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function requireInt(name: string): number {
  const val = parseInt(requireEnv(name), 10);
  if (isNaN(val)) throw new Error(`Env var ${name} must be an integer`);
  return val;
}

function requireList(name: string): string[] {
  const items = requireEnv(name).split(',').map(s => s.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`Env var ${name} must contain at least one comma-separated value`);
  }
  return items;
}

function optionalEnv(name: string): string | undefined {
  const val = process.env[name];
  return val ? val : undefined;
}

function optionalJsonRecord(name: string): Record<string, string> {
  const raw = process.env[name];
  if (!raw || raw === '{}') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Env var ${name} must be valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Env var ${name} must be a flat JSON object of string values`);
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`Env var ${name}: value for "${k}" must be a string`);
    }
  }
  return parsed as Record<string, string>;
}

export function loadConfig(): Config {
  return {
    region:             requireEnv('AWS_REGION'),
    ecsCluster:         requireEnv('WEIR_ECS_CLUSTER'),
    taskFamily:         requireEnv('WEIR_TASK_FAMILY'),
    subnetIds:          requireList('WEIR_SUBNET_IDS'),
    securityGroupId:    requireEnv('WEIR_SECURITY_GROUP_ID'),
    resultsBucket:      requireEnv('WEIR_RESULTS_BUCKET'),
    executionRoleArn:   requireEnv('WEIR_EXECUTION_ROLE_ARN'),
    taskRoleArn:        requireEnv('WEIR_TASK_ROLE_ARN'),
    schedulerRoleArn:   requireEnv('WEIR_SCHEDULER_ROLE_ARN'),
    ecrTargetRepo:      requireEnv('WEIR_ECR_TARGET_REPO'),
    ecrSentinelRepo:    requireEnv('WEIR_ECR_SENTINEL_REPO'),
    logGroupName:       requireEnv('WEIR_LOG_GROUP'),
    maxConcurrentScans: requireInt('WEIR_MAX_CONCURRENT_SCANS'),
    teardownMinutes:    requireInt('WEIR_TEARDOWN_MINUTES'),
    targetImageTag:     requireEnv('WEIR_TARGET_IMAGE_TAG'),
    runId:              requireEnv('WEIR_RUN_ID'),
    verbose:            process.env.WEIR_VERBOSE === 'true',
    targetEnvOverrides: optionalJsonRecord('WEIR_TARGET_ENV'),
    targetAuthUrl:      optionalEnv('WEIR_TARGET_AUTH_URL'),
  };
}
