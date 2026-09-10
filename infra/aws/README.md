# oort on AWS Lightsail / EC2 (SH-11c, T1)

Minimal Terraform for **one VM + one extra disk + ports 22/80/443 + a monthly
budget**. Inside the VM the stack is the compose canon
(`infra/rust/docker-compose.rust.yml` + `caddy.override.yml` + `Caddyfile`).
This directory does **not** fork compose.

Lightsail is the default (ADR-0184 table order, VPS-priced, fixed monthly).
EC2 is `compute = "ec2"` in the same module. Measure one of them live; `terraform
validate` covers the other fork.

Harness-agnostic: any operator shell with `aws` CLI + Terraform. Platform
tokens never land in chat, issues, or this tree (ADR-0004 / ADR-0184 D2).

## What apply creates

Lightsail (default), **7 resources**:

| Resource | Role |
|---|---|
| `aws_lightsail_instance` | Ubuntu LTS, bundle RAM ≥ 2 GiB (`small_3_0` default) |
| `aws_lightsail_static_ip` + attachment | DNS A target |
| `aws_lightsail_disk` + attachment | `/data`, `lifecycle.prevent_destroy = true` |
| `aws_lightsail_instance_public_ports` | **22 / 80 / 443 only** |
| `aws_budgets_budget` | monthly COST limit, email at 80% actual |

EC2 fork, **6 resources**: `aws_instance` + security group (same 3 ports) +
`aws_ebs_volume` (`prevent_destroy`) + attachment + EIP + the same budget.

Postgres **5432 is not a public port**. Compose `postgres` stays on the docker
network. Opening 5432 is a hard fail of `scripts/tests/test_aws_recipe.sh`.

## IAM (minimum)

Attach [`iam-policy.json`](iam-policy.json) to an **IAM user or SSO role**.
**Do not use the root user.**

The agent, in the operator's session:

```sh
aws sts get-caller-identity --query Arn --output text
```

Confirm that ARN is the operator's own user/role. **Do not print the account
id.**

Lightsail does not support resource-level IAM for these calls, so the policy
uses `Resource: *` on the listed actions only (instance, disk, ports, static
IP, tags, budgets view/modify).

### EC2 fork — extra policy (not in iam-policy.json)

When `compute = "ec2"`, the role also needs EC2 create/describe/delete for
instances, volumes, security groups, and addresses. Attach a **second**
statement; do not widen the Lightsail file into `ec2:*`.

```
ec2:RunInstances, TerminateInstances, DescribeInstances, DescribeInstanceStatus,
StartInstances, StopInstances, RebootInstances, CreateTags, DeleteTags,
CreateVolume, DeleteVolume, AttachVolume, DetachVolume, DescribeVolumes,
CreateSecurityGroup, DeleteSecurityGroup, AuthorizeSecurityGroupIngress,
RevokeSecurityGroupIngress, DescribeSecurityGroups,
AllocateAddress, ReleaseAddress, AssociateAddress, DisassociateAddress,
DescribeAddresses, DescribeImages, DescribeSubnets, DescribeVpcs
```

Still no root user.

## Human approval points (owner's account, owner's bill)

1. AWS login / SSO in the **browser** (IAM user or SSO role, not root; the agent stops and hands the screen over).
2. `terraform apply` after the agent has shown the **plan resource count**
   (Lightsail 7 / EC2 6). This is the moment cost starts.
3. Budgets notification **email** — open it and confirm the subscription.
4. DNS **A record** for the operator's host → `public_ip` output.
5. `terraform destroy` **and** deleting the data disk (`prevent_destroy` makes
   this two steps). Data destruction.

Nothing else needs a human. The agent does not click the console for them
(ADR-0184 D2).

## Procedure

Working directory: the oort checkout on the **operator's machine** (not the
VM yet). Credentials from `aws sso login` or `aws configure` — never from
`.tf` / `tfvars` committed to git.

Copy `terraform.tfvars` from the keys below. That file is gitignored.

```
aws_region           = "us-east-1"
availability_zone    = "us-east-1a"
compute              = "lightsail"
ssh_key_name         = "<existing-lightsail-key-pair>"
budget_alert_email   = "<operator-email>"
monthly_budget_usd   = 25
oort_issue           = "2377"
# compute = "ec2" also needs:
# ec2_ami_id    = "<ubuntu-lts-ami-in-this-region>"
# ec2_vpc_id    = "<vpc>"
# ec2_subnet_id = "<public-subnet>"
```

```sh
aws sso login
aws sts get-caller-identity --query Arn --output text
cd infra/aws/terraform
terraform init
terraform plan -out=tfplan
terraform show -json tfplan | jq '.resource_changes | length'
```

Show that length to the operator (Lightsail 7, EC2 6). **Stop.** Approval
point 2 is `terraform apply tfplan`.

```sh
terraform output public_ip
```

Approval point 4: DNS A for `https://<host>` → that IP. ACME only for a name
this VM's DNS owns.

SSH (Ubuntu):

```sh
ssh ubuntu@<public_ip>
```

On the VM, `/data/oort` is the clone pinned to `releases/latest.json`'s
`version` tag. Image ref is `/data/oort-image-ref`. Env is generated **on the
VM** (secrets stay under `/data`, never in cloud-init):

```sh
cd /data/oort
IMAGE_REF="$(cat /data/oort-image-ref)"
scripts/self_host_env.sh --platform aws-lightsail --published-image "$IMAGE_REF" --public-origin https://<host>
scripts/oort up
```

Public edge is the VPS overlay (`caddy.override.yml` + `Caddyfile`) from
[`docs/SELF_HOST_AGENT.md`](../../docs/SELF_HOST_AGENT.md) §3.2. Then:

```sh
scripts/oort doctor --json
```

**Done** means doctor PASS including `public.healthz` / `public.websocket`,
public `/v1/centrifugo/subscribe` is 403, and `nc -z <public_ip> 5432` fails.

Day-2 is SSH, same as VPS: `scripts/oort backup` / `restore` / `upgrade`.

## Destroy (approval point 5)

```sh
terraform destroy
```

The data disk (`aws_lightsail_disk` / `aws_ebs_volume`) has
`prevent_destroy = true`, so this command **stops** on that resource. That is
the point. To actually delete data:

1. Operator confirms they want the disk gone (approval 5).
2. Temporarily set `prevent_destroy = false` on the disk resource (local
   edit, not committed), `terraform apply`, then `terraform destroy`.
3. Restore `prevent_destroy = true` in the tree afterwards.

## Cost (list prices, not a live bill)

Lightsail `small_3_0` (2 GiB RAM) is the default bundle — AWS's published
monthly price for that bundle plus the extra disk (GiB × Lightsail SSD
rate) plus a static IP that is free while attached. EC2 `t3.small` + gp3 +
EIP is the fork. Record the **measured** period charge on a live run; this
recipe does not apply itself.

## Invariants this recipe must not lose

- Compose canon unchanged (`infra/rust/**`).
- Firewall set == `{22, 80, 443}`. Never 5432.
- Extra disk mounted at `/data`; Docker `data-root=/data/docker` (a root-disk
  data-root loses message count across reboot).
- Bundle / instance type from the RAM ≥ 2 GiB allow-list.
- `aws_budgets_budget` present.
- Zero `AKIA…` / 12-digit account ids / email literals in `.tf` / `.yaml` /
  `.json`.
- cloud-init does not write `PASSWORD=` / `SECRET=` and does not start the
  stack.

Contract test: `scripts/tests/test_aws_recipe.sh`.
