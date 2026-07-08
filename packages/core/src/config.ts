export interface Config {
  region: string;
  ecsCluster: string;
  taskFamily: string;
  subnetId: string;
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

export function loadConfig(): Config {
  return {
    region:             requireEnv('AWS_REGION'),
    ecsCluster:         requireEnv('WEIR_ECS_CLUSTER'),
    taskFamily:         requireEnv('WEIR_TASK_FAMILY'),
    subnetId:           requireEnv('WEIR_SUBNET_ID'),
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
  };
}
