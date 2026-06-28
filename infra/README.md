# Sentinel Gate — Infrastructure

Ephemeral, network-isolated DAST gate. On each pull request, CI builds the PR's
version of the target API, runs it as a Fargate task with Sentinel scanning it
as a sidecar, writes the report to S3, and tears the task down. The target is
never exposed to the internet — it has no route there at all.

## Architecture

```
GitHub Actions (OIDC, no stored keys)
   │  assume gha role → build/push target image → register task def → RunTask
   ▼
ECS Fargate task (private subnet, no internet route)
   ├─ target    : PR build of the vulnerable API, :3000
   └─ sentinel  : scans http://localhost:3000, writes report → S3, exits
   │
   │  (egress only via VPC endpoints: ECR, S3, Logs)
   ▼
S3 results bucket  ──read──►  GitHub Actions surfaces findings on the PR
```

Two containers in one task share a network namespace, so Sentinel reaches the
target over loopback. No proxy, no private-IP resolution, no service discovery.

## Why no NAT gateway

The subnet has no Internet Gateway and no NAT — there is no `0.0.0.0/0` route
anywhere. The task reaches AWS only through VPC endpoints (ECR API/DKR for image
pull, S3 gateway for layer blobs and results, CloudWatch Logs). A compromised
target container therefore cannot exfiltrate or make outbound connections;
egress is denied by construction, not by a policy that can be misconfigured.
This also costs less than a NAT gateway for an intermittent workload.

## IAM role separation

| Role | Assumed by | Can do |
|---|---|---|
| `execution` | ECS agent | pull images, write logs |
| `task` | the containers at runtime | `s3:PutObject` to `results/*` only |
| `gha` | GitHub Actions via OIDC | push ECR, RunTask, read results |
| `scheduler` | EventBridge Scheduler | `ecs:StopTask` (teardown backstop) |

`execution` and `task` are kept separate on purpose: a popped target holds only
the task role (write one S3 prefix) and never the pull/log credentials.
`gha`'s `iam:PassRole` is scoped to exactly the execution and task role ARNs.

## Backstops

- **Atomic teardown** — sentinel is the only essential container; when it exits,
  ECS stops the task and the target with it.
- **One-shot schedule** — the CLI creates an EventBridge schedule at `now + N`
  min that calls `StopTask`, covering a wedged run. Created at runtime (the task
  ARN is unknown until `RunTask`); the role it assumes is `scheduler_role_arn`.
- **Concurrency cap** — the CLI counts RUNNING/PENDING tasks in the family and
  refuses to launch past `max_concurrent_scans`. Not an ECS-native limit.
- **Billing alarm** — `EstimatedCharges` over threshold → SNS.

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars   # edit github_repo, alarm_email
terraform init
terraform apply
```

One-time account toggles:

- Billing → enable "Receive CloudWatch billing alerts" (the metric won't publish
  otherwise).
- If the account already has a GitHub OIDC provider, set
  `create_oidc_provider = false`.

The baseline task definition references `:bootstrap` / `:latest` image tags that
don't exist until the first CI push, so `terraform apply` provisions the shape
but a real scan needs the pipeline to push images first.

## APP-SIDE contract (not in Terraform)

Two glue pieces live in the application/CLI layer, not here:

1. **Sentinel → S3 upload.** The sentinel container receives `TARGET_URL`,
   `RESULTS_BUCKET`, and `RUN_ID`. It must scan `TARGET_URL` and upload its JSON
   report to `s3://$RESULTS_BUCKET/results/$RUN_ID.json`. Either teach Sentinel
   an `--out s3://...` flag or wrap it in an entrypoint that runs the scan and
   `aws s3 cp`s the result. The task role already grants `PutObject` there.

2. **Orchestrator CLI.** Registers a task-def revision with the target image
   pinned to the PR SHA, enforces the concurrency cap, `RunTask`s into the
   private subnet + task SG with `assignPublicIp=DISABLED`, creates the one-shot
   teardown schedule, polls `DescribeTasks` to `STOPPED`, reads the S3 report,
   exits nonzero on findings.

```

## Per-run container overrides

The baseline task definition sets `RESULTS_BUCKET` from Terraform but intentionally
omits `RUN_ID` — it is unique per scan and must be passed as a container override
at `RunTask` time. The orchestrator CLI handles this automatically. For manual
smoke tests, pass it explicitly:

```bash
--overrides '{"containerOverrides":[{"name":"sentinel","environment":[{"name":"RUN_ID","value":"smoke-test-1"}]}]}'
```

Without `RUN_ID`, Sentinel logs a partial pipeline warning and skips the S3
upload — the task will complete but no report will be written.

## Cost note

Three interface endpoints (~$0.01/hr each) run continuously ≈ $21/mo, plus
negligible S3/logs. No NAT, no idle compute. Destroy with `terraform destroy`
when not actively iterating to drop it to near-zero.
