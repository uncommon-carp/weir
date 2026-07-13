import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

// Matches Sentinel's RunResult shape (sentinel/src/core/types.ts) field-for-
// field: meta/config/findings/suiteErrors/reporterErrors. Named ScanReport
// rather than reusing RunResult on purpose: Weir doesn't import Sentinel's
// package or share types across the process/repo boundary — a hand-
// maintained mirror here, not dead placeholder code (Barbel's ADR-004 makes
// the analogous call for its own orchestrator boundary, forking rather than
// importing across a repo line). `Finding` here is intentionally looser
// than Sentinel's (`id`/`severity`/`title` plus an index signature) since
// Weir only ever reads those three fields to decide the exit code — it
// doesn't need `whyItMatters`/`remediation`/etc. If Sentinel's actual shape
// ever diverges, update this file to match — Weir adapts to Sentinel, not
// the other way around (see "Sentinel is truth" in the root CLAUDE.md).

export interface SuiteError {
  suite: string;
  message: string;
}

export interface ReporterError {
  reporter: string;
  message: string;
}

export interface RunMeta {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  targetBaseUrl: string;
  version: string;
}

export interface Finding {
  id: string;
  severity: string;
  title: string;
  [key: string]: unknown;
}

export interface ScanReport {
  meta: RunMeta;
  config: Record<string, unknown>;
  findings: Finding[];
  suiteErrors: SuiteError[];
  reporterErrors: ReporterError[];
}

export class ResultsReader {
  private client: S3Client;
  private key: string;

  constructor(private config: Config, private logger: Logger) {
    this.client = new S3Client({ region: config.region });
    this.key = `results/${config.runId}.json`;
  }

  async read(): Promise<ScanReport> {
    const { Body } = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.resultsBucket,
        Key: this.key,
      })
    );
    if (!Body) throw new Error(`Empty S3 response for ${this.key}`);
    const report = JSON.parse(await Body.transformToString()) as ScanReport;
    this.logger.debug('Read scan report from S3', {
      event: 'weir.results.read',
      s3Uri: this.s3Uri(),
      findingCount: report.findings?.length ?? 0,
    });
    return report;
  }

  s3Uri(): string {
    return `s3://${this.config.resultsBucket}/${this.key}`;
  }
}
