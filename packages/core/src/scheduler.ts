import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  FlexibleTimeWindowMode,
} from '@aws-sdk/client-scheduler';
import type { Config } from './config.js';

export class TeardownScheduler {
  private client: SchedulerClient;
  private scheduleName: string;

  constructor(private config: Config) {
    this.client = new SchedulerClient({ region: config.region });
    this.scheduleName = `sentinel-gate-${config.runId}`;
  }

  async create(taskArn: string): Promise<void> {
    const fireAt = new Date(Date.now() + this.config.teardownMinutes * 60 * 1000);
    const scheduleExpression = `at(${fireAt.toISOString().replace(/\.\d{3}Z$/, '')})`;

    await this.client.send(
      new CreateScheduleCommand({
        Name: this.scheduleName,
        ScheduleExpression: scheduleExpression,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: FlexibleTimeWindowMode.OFF },
        ActionAfterCompletion: 'DELETE',
        Target: {
          Arn: 'arn:aws:scheduler:::aws-sdk:ecs:stopTask',
          RoleArn: this.config.schedulerRoleArn,
          Input: JSON.stringify({
            Cluster: this.config.ecsCluster,
            Task: taskArn,
            Reason: `weir teardown backstop (run ${this.config.runId})`,
          }),
        },
      })
    );
  }

  async cancel(): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({ Name: this.scheduleName })
      );
    } catch (err: any) {
      if (err?.name !== 'ResourceNotFoundException') throw err;
    }
  }
}
