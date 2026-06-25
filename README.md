# Weir

Ephemeral DAST gate for the [Sentinel](https://github.com/uncommon-carp/sentinel) / [Anemone](https://github.com/uncommon-carp/anemone) pipeline. Provisions a network-isolated Fargate task per pull request — target API and Sentinel scanner sharing a network namespace — runs the scan, surfaces findings on the PR, and tears down. The target never touches the internet.

## The trinity

| Repo | Role |
|---|---|
| [sentinel](https://github.com/uncommon-carp/sentinel) | OWASP API scanner — the tool |
| [anemone](https://github.com/uncommon-carp/anemone) | Deliberately vulnerable target API — the scan fixture |
| **weir** (this) | Ephemeral gate — provisions, orchestrates, tears down |

Each artifact is consumed by the next: Anemone is scanned by Sentinel, driven by Weir, triggered by Anemone's CI.

## How it works

```
Anemone PR → Weir scan.yml (reusable workflow)
  │  OIDC assume-role (no stored keys)
  │  build + push target image (PR SHA)
  │  register task-def revision
  │  RunTask → private subnet, no public IP
  ▼
Fargate task
  ├─ target   : PR build of Anemone :3000
  └─ sentinel : scans http://localhost:3000 → report → S3 → exits
       │
       │ egress only via VPC endpoints — no internet route
  ▼
S3 report → CLI reads → exit nonzero on findings → PR check fails
```

## Structure

```
weir/
├── packages/
│   ├── core/          # AWS orchestration logic (importable library)
│   │   └── src/
│   │       ├── index.ts      # public exports
│   │       ├── config.ts     # env → typed config
│   │       ├── ecs.ts        # concurrency cap, RunTask, poll
│   │       ├── scheduler.ts  # one-shot teardown backstop
│   │       └── results.ts    # S3 report reader
│   └── cli/           # thin entrypoint, imports core
│       └── src/cli.ts
├── infra/             # Terraform — VPC, ECS, IAM, S3, billing alarm
├── action.yml         # GitHub Action wrapper (calls cli)
└── .github/workflows/
    ├── ci.yml         # lint/validate/test on push + PR
    └── scan.yml       # reusable workflow called by Anemone
```

## Security properties

- **No internet egress.** Private subnet, no IGW, no NAT. VPC endpoints only (ECR, S3, Logs). A compromised target container has nowhere to go.
- **No stored AWS keys.** OIDC federation — GHA assumes a role via web identity token.
- **Least-privilege IAM.** Four roles (execution, task, GHA, scheduler). Task role can only `s3:PutObject` to `results/*`. `iam:PassRole` scoped to exact ARNs.
- **Atomic teardown.** Sentinel is the only essential container; its exit stops the task and target.
- **Backstop teardown.** One-shot EventBridge schedule fires `StopTask` at T+N min.
- **Concurrency cap.** CLI refuses `RunTask` past `max_concurrent_scans`.
- **Billing alarm.** EstimatedCharges CloudWatch alarm with SNS email.

## Scanner scope

Weir runs Sentinel in Tier-0 mode: passive surface scanning (headers, CORS, inventory, JWT shape, injection surface). Authorization-logic vulnerabilities require multi-identity testing and are out of scope for this black-box gate. Tier-2 opt-in is on the roadmap.

## Connecting a target repo

In the target repo, create `.github/workflows/scan.yml`:

```yaml
on:
  pull_request:

jobs:
  scan:
    uses: uncommon-carp/weir/.github/workflows/scan.yml@main
    with:
      target-image-tag: ${{ github.sha }}
    secrets: inherit
```

Set `WEIR_GHA_ROLE_ARN` and `WEIR_AWS_REGION` as repository variables. Done.

## Infra

See [infra/README.md](infra/README.md) for architecture, IAM breakdown, and apply instructions.
