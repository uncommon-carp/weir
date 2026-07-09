# Weir — Architecture

## The Trinity

Weir is one of three interconnected repos that form a DAST pipeline:

| Repo | Role | Published as |
|---|---|---|
| `sentinel` | OWASP API scanner — the tool that runs checks | `@uncommon-carp/sentinel` on npm |
| `anemone` | Deliberately vulnerable target API — the scan fixture | Docker image on ECR |
| `weir` | Ephemeral gate — provisions, orchestrates, tears down | GHA reusable workflow + Action |

**Data flow:**

```
Anemone PR
  └─▶ Weir scan.yml (reusable workflow, called by Anemone's CI)
        ├─ OIDC assume gha role (no stored keys)
        ├─ build + push Anemone image (tagged :$SHA)
        ├─ register Fargate task-def revision (target image pinned to $SHA)
        ├─ RunTask → private subnets (multi-AZ), assignPublicIp=DISABLED
        │     ├─ container: target  (Anemone :$SHA, port 3000)
        │     └─ container: sentinel (scans http://localhost:3000)
        │           └─ PutObject → s3://results-bucket/results/$RUN_ID.json
        ├─ poll DescribeTasks → STOPPED
        ├─ GetObject → read report
        └─ exit 0 (clean) | exit 1 (findings) → PR check passes/fails
```

Each artifact is consumed by the next. Anemone is the subject, Sentinel is the scanner, Weir is the harness. None of them are aware of each other at the code level — the coupling is purely through environment variables and S3.

---

## Network architecture

```
AWS Account
└─ VPC (10.20.0.0/16)
   ├─ Private subnet A (10.20.1.0/24) — ${region}a
   ├─ Private subnet B (10.20.2.0/24) — ${region}b
   │     ├─ No Internet Gateway
   │     ├─ No NAT Gateway
   │     ├─ No 0.0.0.0/0 route anywhere
   │     │
   │     ├─ Fargate scan task (one ENI, task SG — lands in whichever subnet ECS picks)
   │     │   ├─ target container   :3000
   │     │   └─ sentinel container → localhost:3000
   │     │
   │     └─ VPC Endpoints (the only egress; interface endpoints have an ENI in each subnet)
   │         ├─ ecr.api  (interface) — task def / image metadata
   │         ├─ ecr.dkr  (interface) — image layer pull
   │         ├─ logs     (interface) — CloudWatch log delivery
   │         └─ s3       (gateway)  — ECR layer blobs + results upload (route-table scoped, shared)
```

**Why no NAT.** The task has no route to the public internet by construction, not by policy. This means:

- A compromised target container cannot exfiltrate data.
- A planted SSRF vulnerability cannot reach an external attacker-controlled server.
- It's cheaper than NAT (~$21/mo interface endpoints vs ~$32/mo NAT + data).

The tradeoff: the interface endpoints run continuously. Run `terraform destroy` between active development periods to drop cost to near-zero.

---

## IAM roles

Four roles, deliberately not merged. The separation is load-bearing — not convention.

```
┌─────────────────┬──────────────────────────┬─────────────────────────────────────┐
│ Role            │ Assumed by               │ Permissions                         │
├─────────────────┼──────────────────────────┼─────────────────────────────────────┤
│ execution       │ ECS agent                │ ecr:GetAuthorizationToken           │
│                 │ (control plane)          │ ecr:BatchGetImage + layer download  │
│                 │                          │ logs:CreateLogStream + PutLogEvents │
├─────────────────┼──────────────────────────┼─────────────────────────────────────┤
│ task            │ Running containers       │ s3:PutObject → results/* only       │
│                 │ (runtime)                │ Nothing else                        │
├─────────────────┼──────────────────────────┼─────────────────────────────────────┤
│ gha             │ GitHub Actions via OIDC  │ ecr:* on target + sentinel repos    │
│                 │                          │ ecs:RegisterTaskDefinition          │
│                 │                          │ ecs:RunTask/StopTask/DescribeTasks  │
│                 │                          │ iam:PassRole → execution + task only│
│                 │                          │ scheduler:CreateSchedule/Delete     │
│                 │                          │ s3:GetObject + ListBucket           │
├─────────────────┼──────────────────────────┼─────────────────────────────────────┤
│ scheduler       │ EventBridge Scheduler    │ ecs:StopTask (backstop teardown)    │
└─────────────────┴──────────────────────────┴─────────────────────────────────────┘
```

**The critical separation:** `execution` and `task` are distinct because the ECS agent needs image-pull and log-write credentials at the control plane level, but a running container should never hold those. A compromised target gets the `task` role — write one S3 prefix — and nothing else. It cannot pull images, write logs under other streams, or touch any other AWS service.

**`iam:PassRole` scope.** The `gha` role's PassRole is scoped to exactly the `execution` and `task` role ARNs with a `PassedToService: ecs-tasks.amazonaws.com` condition. An unscoped `PassRole: *` is privilege escalation — any reviewer who knows IAM looks for this.

**OIDC federation.** No stored AWS keys anywhere in GitHub. The `gha` role trust policy allows assumption only from `token.actions.githubusercontent.com` with `sub` matching `repo:uncommon-carp/weir:*`. Tighten to a specific branch or environment for production use.

---

## Task lifecycle

```
CLI: registerRevision()
  └─▶ ECS: new task-def revision (target image = :$SHA, sentinel image = :latest)

CLI: runTask()
  ├─ countActiveTasks() — refuses if >= max_concurrent_scans
  └─▶ ECS: RunTask
        ├─ target starts, health check polls /api/v2/health every 5s
        └─ sentinel starts only after target is HEALTHY (dependsOn condition)

CLI: scheduler.create(taskArn)
  └─▶ EventBridge: one-shot schedule at now + teardown_minutes
        └─ fires StopTask if CLI is cancelled, runner dies, or task wedges

CLI: waitForCompletion()
  └─ polls DescribeTasks with exponential backoff (5s → 30s max)
        └─ returns when lastStatus = STOPPED

sentinel exits (essential=true)
  └─▶ ECS stops the task → target container stops with it (essential=false)
        └─ atomic teardown: no separate cleanup step needed

CLI: results.read()
  └─▶ S3: GetObject results/$RUN_ID.json
        └─ exit 0 (no findings) | exit 1 (findings)

CLI: scheduler.cancel()
  └─▶ EventBridge: DeleteSchedule (no-op if already fired and self-deleted)
```

**Teardown is layered:**

1. **Atomic** — sentinel exits → ECS stops the task. Covers the normal path.
2. **Backstop** — EventBridge one-shot fires `StopTask` at T+N. Covers cancelled runners and wedged tasks.
3. **Concurrency cap** — CLI refuses to `RunTask` past `max_concurrent_scans`. Covers runaway loops.
4. **Billing alarm** — CloudWatch `EstimatedCharges` alert. Covers everything else.

---

## Monorepo structure

```
weir/
├── packages/
│   ├── core/                  # @uncommon-carp/weir-core
│   │   └── src/
│   │       ├── index.ts       # public exports — the library boundary
│   │       ├── config.ts      # env vars → typed Config
│   │       ├── ecs.ts         # EcsOrchestrator: register, runTask, poll, stop
│   │       ├── scheduler.ts   # TeardownScheduler: create, cancel
│   │       └── results.ts     # ResultsReader: S3 GetObject → ScanReport
│   └── cli/                   # @uncommon-carp/weir-cli
│       └── src/
│           └── cli.ts         # thin entrypoint — import core, sequence, process.exit
├── infra/                     # Terraform (flat, no modules)
│   ├── versions.tf            # provider pins
│   ├── variables.tf           # all inputs
│   ├── main.tf                # locals, data sources
│   ├── network.tf             # VPC, subnets (multi-AZ), SG, VPC endpoints
│   ├── iam.tf                 # four roles + policies
│   ├── ecs.tf                 # cluster, ECR repos, log group, task def
│   ├── s3.tf                  # results bucket
│   ├── observability.tf       # billing alarm + SNS
│   ├── ssm.tf                 # publishes CI config to SSM Parameter Store
│   └── outputs.tf             # everything the CLI consumes; human/local `terraform output` use
├── action.yml                 # GitHub Action wrapper → packages/cli/dist/cli.js
└── .github/workflows/
    ├── ci.yml                 # lint + terraform validate + build on push/PR
    └── scan.yml               # reusable workflow called by Anemone's CI
```

**Why `core` and `cli` are separate packages.** `core` is a library — importable, testable in isolation, no process.exit. `cli` is the delivery mechanism. A future `packages/lambda` handler would import `core` and skip the CLI wrapper entirely, with no refactoring needed.

**Why infra is flat (no Terraform modules).** The infrastructure is small enough that modules add indirection without benefit. A flat layout is easier to read and the right call at this scale. Reviewers read over-modularized Terraform as a complexity-for-complexity's-sake signal.

---

## Configuration

All runtime config flows through environment variables, read by `packages/core/src/config.ts` on startup. In CI, the `scan.yml` workflow populates these from AWS SSM Parameter Store (published under `/weir/ci/*` by `terraform apply`, see `infra/ssm.tf`) after assuming the OIDC role.

| Variable | Source | Description |
|---|---|---|
| `AWS_REGION` | GHA var | Region everything lives in |
| `WEIR_ECS_CLUSTER` | SSM | ECS cluster name |
| `WEIR_TASK_FAMILY` | SSM | Task definition family |
| `WEIR_SUBNET_IDS` | SSM | Comma-separated private subnet IDs (AZ a + b) for RunTask |
| `WEIR_SECURITY_GROUP_ID` | SSM | Task SG (no ingress, 443 egress to endpoints) |
| `WEIR_RESULTS_BUCKET` | SSM | S3 bucket for scan reports |
| `WEIR_EXECUTION_ROLE_ARN` | SSM | Passed to RunTask |
| `WEIR_TASK_ROLE_ARN` | SSM | Passed to RunTask |
| `WEIR_SCHEDULER_ROLE_ARN` | SSM | Passed to CreateSchedule |
| `WEIR_ECR_TARGET_REPO` | SSM | ECR repo URL for target images |
| `WEIR_ECR_SENTINEL_REPO` | SSM | ECR repo URL for Sentinel image |
| `WEIR_LOG_GROUP` | SSM | CloudWatch log group for both containers |
| `WEIR_MAX_CONCURRENT_SCANS` | SSM | Soft concurrency cap |
| `WEIR_TEARDOWN_MINUTES` | SSM | Backstop TTL |
| `WEIR_TARGET_IMAGE_TAG` | GHA (`github.sha`) | PR build tag |
| `WEIR_RUN_ID` | GHA run ID + attempt | S3 key + schedule name |
| `WEIR_VERBOSE` | optional, unset by default | `"true"` enables debug-level logging (task polling, schedule create/cancel, S3 reads) |

**SSM, not `terraform output`.** `infra/ssm.tf` publishes every value above CI needs to `/weir/ci/*` as part of `terraform apply`; `scan.yml` reads them with `aws ssm get-parameter`. CI never runs a `terraform` command and has no dependency on Terraform state or backend credentials — this was previously a real gap (`terraform init -backend=false` + `terraform output` breaks the moment a remote backend is configured) and is now resolved.

---

## Sentinel contract

Weir treats Sentinel as a black box with one interface: write a JSON report to S3 before exiting.

**Environment variables Sentinel receives:**

```
TARGET_URL       http://localhost:3000
RESULTS_BUCKET   <bucket name>
RUN_ID           weir-<run_id>-<attempt>
```

**Expected S3 write:**

```
s3://$RESULTS_BUCKET/results/$RUN_ID.json
```

**Expected report shape** (defined in `packages/core/src/results.ts`):

```typescript
interface ScanReport {
  findings: Finding[];
  summary: Record<string, unknown>;
}

interface Finding {
  id: string;       // e.g. "cors.origin_reflection"
  severity: string; // e.g. "high"
  title: string;
  [key: string]: unknown;
}
```

If Sentinel's actual output shape diverges, update `results.ts` to match — Weir adapts to Sentinel, not the other way around.

**Sentinel exit codes.** Weir reads the sentinel container's exit code from `DescribeTasks` but doesn't gate on it — it gates on finding count from the S3 report. A nonzero exit with no S3 report is an orchestration error (Weir exits 1).

---

## Scanner scope

Weir runs Sentinel in **Tier-0** mode: passive black-box surface scanning.

| Tier | Mode | Input required | Checks |
|---|---|---|---|
| 0 | Passive surface | URL only | Headers, CORS, inventory, JWT shape, injection surface |
| 1 | Authenticated | URL + auth flow | JWT enforcement, authenticated inventory, mass assignment |
| 2 | Multi-identity | URL + ≥2 identities + policy declaration | BOLA, BFLA |

Tier-1 and Tier-2 are on the Sentinel roadmap as opt-in. Tier-2 mutating checks (e.g. confirming BFLA by actually deleting a resource) are the reason ephemeral provisioning is load-bearing — clean state per run makes destructive checks safe and repeatable.

**Honest scope statement.** Weir in its current form catches misconfiguration, inventory, and auth-shape vulnerabilities. Authorization-logic vulnerabilities (BOLA, BFLA) require multi-identity authenticated testing and are explicitly out of scope for this black-box gate. This is a true statement about DAST coverage, not a gap to paper over.

---

## Known rough edges

- **`action.yml` references pre-built `dist/`.** Composite Actions can't build before running. Options: commit `dist/` on releases, or switch to a composite action with explicit build steps. Decide before wiring Anemone.
- **`ScanReport` shape is a placeholder.** Pin to Sentinel's actual output once the S3 feature ships.
