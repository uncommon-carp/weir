import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RegisterTaskDefinitionCommand,
  type ContainerDefinition,
} from '@aws-sdk/client-ecs';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export interface RunResult {
  taskArn: string;
  exitCode: number | undefined;
  stoppedReason: string | undefined;
}

// WEIR_TARGET_ENV is a free-form JSON object (arbitrary key names), unlike
// Sentinel's fixed-shape Credential type, so redaction here is by key-name
// pattern rather than by field. Mirrors Sentinel's redactCredential intent
// (sentinel/src/config/load.ts) — don't let secret-shaped values reach logs.
const SECRET_ENV_KEY_PATTERN = /secret|token|password|passwd|credential|apikey|api_key/i;

function redactSecretShapedEnv(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(overrides).map(([k, v]) => [k, SECRET_ENV_KEY_PATTERN.test(k) ? '***' : v])
  );
}

export class EcsOrchestrator {
  private client: ECSClient;

  constructor(private config: Config, private logger: Logger) {
    this.client = new ECSClient({ region: config.region });
  }

  // Registers a new task-def revision with the target image pinned to the PR
  // SHA. The family, roles, and resource shape stay as Terraform defined them;
  // only the target image tag changes per run.
  async registerRevision(): Promise<string> {
    const { taskDefinition } = await this.client.send(
      new RegisterTaskDefinitionCommand({
        family: this.config.taskFamily,
        networkMode: 'awsvpc',
        requiresCompatibilities: ['FARGATE'],
        cpu: '512',
        memory: '1024',
        executionRoleArn: this.config.executionRoleArn,
        taskRoleArn: this.config.taskRoleArn,
        containerDefinitions: this.buildContainerDefinitions(),
        tags: [{ key: 'weir-run-id', value: this.config.runId }],
      })
    );
    if (!taskDefinition?.taskDefinitionArn) {
      throw new Error('RegisterTaskDefinition returned no ARN');
    }
    this.logger.debug('Registered task definition revision', {
      event: 'weir.taskdef.register',
      taskFamily: this.config.taskFamily,
      taskDefinitionArn: taskDefinition.taskDefinitionArn,
      targetImageTag: this.config.targetImageTag,
    });
    return taskDefinition.taskDefinitionArn;
  }

  private buildContainerDefinitions(): ContainerDefinition[] {
    const {
      ecrTargetRepo,
      ecrSentinelRepo,
      resultsBucket,
      runId,
      region,
      logGroupName,
      targetEnvOverrides,
      targetAuthUrl,
      targetPort,
      targetHealthCheckPath,
    } = this.config;

    if (Object.keys(targetEnvOverrides).length > 0) {
      this.logger.debug('Applying target env overrides', {
        event: 'weir.target.env.override',
        overrides: redactSecretShapedEnv(targetEnvOverrides),
      });
    }
    const targetEnv = { PORT: String(targetPort), ...targetEnvOverrides };

    if (targetAuthUrl) {
      this.logger.debug('Passing auth token URL to sentinel', {
        event: 'weir.sentinel.auth.configured',
        targetAuthUrl,
      });
    }
    const sentinelEnv: { name: string; value: string }[] = [
      { name: 'TARGET_URL', value: `http://localhost:${targetPort}` },
      { name: 'RESULTS_BUCKET', value: resultsBucket },
      { name: 'RUN_ID', value: runId },
    ];
    if (targetAuthUrl) {
      sentinelEnv.push({ name: 'AUTH_TOKEN_URL', value: targetAuthUrl });
    }

    return [
      {
        name: 'target',
        image: `${ecrTargetRepo}:${this.config.targetImageTag}`,
        essential: false,
        portMappings: [{ containerPort: targetPort, protocol: 'tcp' }],
        environment: Object.entries(targetEnv).map(([name, value]) => ({ name, value })),
        healthCheck: {
          command: [
            'CMD-SHELL',
            `node -e "require('http').get('http://localhost:${targetPort}${targetHealthCheckPath}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"`,
          ],
          interval: 5,
          timeout: 3,
          retries: 5,
          startPeriod: 10,
        },
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroupName,
            'awslogs-region': region,
            'awslogs-stream-prefix': 'target',
          },
        },
      },
      {
        name: 'sentinel',
        image: `${ecrSentinelRepo}:latest`,
        essential: true,
        dependsOn: [{ containerName: 'target', condition: 'HEALTHY' }],
        environment: sentinelEnv,
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroupName,
            'awslogs-region': region,
            'awslogs-stream-prefix': 'sentinel',
          },
        },
      },
    ];
  }

  async countActiveTasks(): Promise<number> {
    const [running, pending] = await Promise.all([
      this.client.send(new ListTasksCommand({
        cluster: this.config.ecsCluster,
        family: this.config.taskFamily,
        desiredStatus: 'RUNNING',
      })),
      this.client.send(new ListTasksCommand({
        cluster: this.config.ecsCluster,
        family: this.config.taskFamily,
        desiredStatus: 'PENDING',
      })),
    ]);
    return (running.taskArns?.length ?? 0) + (pending.taskArns?.length ?? 0);
  }

  async runTask(taskDefinitionArn: string): Promise<string> {
    const active = await this.countActiveTasks();
    if (active >= this.config.maxConcurrentScans) {
      throw new Error(
        `Concurrency cap: ${active}/${this.config.maxConcurrentScans} active. Retry later.`
      );
    }

    const result = await this.client.send(
      new RunTaskCommand({
        cluster: this.config.ecsCluster,
        taskDefinition: taskDefinitionArn,
        launchType: 'FARGATE',
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: this.config.subnetIds,
            securityGroups: [this.config.securityGroupId],
            assignPublicIp: 'DISABLED',
          },
        },
        tags: [{ key: 'weir-run-id', value: this.config.runId }],
      })
    );

    const taskArn = result.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const failure = result.failures?.[0];
      throw new Error(`RunTask failed: ${failure?.reason ?? 'unknown'}`);
    }

    // countActiveTasks() above and RunTaskCommand here aren't atomic — two
    // concurrent runTask() calls (separate CI jobs, separate processes) can
    // both pass the check and both launch. There's no ECS-native way to
    // reserve a slot, so instead of preventing the race we detect it right
    // after launch and self-correct: stop the task we just started rather
    // than let the cap be silently exceeded. Mirrors the invariant the
    // caller (runScan) relies on — a task is only ever "live" once this
    // method returns an ARN, so on this path we never return one.
    const activeAfterLaunch = await this.countActiveTasks();
    if (activeAfterLaunch > this.config.maxConcurrentScans) {
      this.logger.warn(
        `Concurrency cap race detected (${activeAfterLaunch}/${this.config.maxConcurrentScans} active after launch) — stopping task ${taskArn} it just started`
      );
      await this.client.send(
        new StopTaskCommand({
          cluster: this.config.ecsCluster,
          task: taskArn,
          reason: 'weir: concurrency cap race, self-corrected',
        })
      );
      throw new Error(
        `Concurrency cap: race detected at launch (${activeAfterLaunch}/${this.config.maxConcurrentScans} active). Retry later.`
      );
    }

    this.logger.debug('Launched scan task', {
      event: 'weir.task.run',
      taskArn,
      activeBeforeLaunch: active,
    });
    return taskArn;
  }

  async waitForCompletion(taskArn: string, timeoutMs = 600_000): Promise<RunResult> {
    const deadline = Date.now() + timeoutMs;
    let delay = 5_000;

    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 30_000);

      const { tasks } = await this.client.send(
        new DescribeTasksCommand({
          cluster: this.config.ecsCluster,
          tasks: [taskArn],
        })
      );

      const task = tasks?.[0];
      if (!task) throw new Error(`Task ${taskArn} not found`);

      this.logger.debug('Polled task status', {
        event: 'weir.task.poll',
        taskArn,
        lastStatus: task.lastStatus,
        nextDelayMs: delay,
      });

      if (task.lastStatus === 'STOPPED') {
        const sentinel = task.containers?.find(c => c.name === 'sentinel');
        this.logger.debug('Task stopped', {
          event: 'weir.task.stopped',
          taskArn,
          exitCode: sentinel?.exitCode,
          stoppedReason: task.stoppedReason,
        });
        return {
          taskArn,
          exitCode: sentinel?.exitCode,
          stoppedReason: task.stoppedReason,
        };
      }
    }
    throw new Error(`Timed out waiting for task ${taskArn}`);
  }

  async stopTask(taskArn: string, reason: string): Promise<void> {
    this.logger.debug('Stopping task', { event: 'weir.task.stop', taskArn, reason });
    await this.client.send(
      new StopTaskCommand({
        cluster: this.config.ecsCluster,
        task: taskArn,
        reason,
      })
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
