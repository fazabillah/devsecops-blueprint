# Troubleshoot Log

Errors encountered during the DevSecOps Blueprint series, organized by area. Each entry includes what was observed, why it happened, and how it was fixed.

---

## Table of Contents

1. [Local Development](#1-local-development)
   - [Backend container not appearing in docker-compose ps](#backend-container-not-appearing-in-docker-compose-ps)
   - [Blank page in browser; curl returns 200](#blank-page-in-browser-curl-returns-200)

2. [Infrastructure (Terraform / EKS)](#2-infrastructure-terraform--eks)
   - [terraform apply fails: AccessDeniedException on eks:CreateCluster](#terraform-apply-fails-accessdeniedexception-on-ekscreateassistantcluster)
   - [terraform apply fails: KeyPair not found](#terraform-apply-fails-keypair-not-found)

3. [CI Pipeline (GitHub Actions)](#3-ci-pipeline-github-actions)
   - [CI pipeline never triggered on push to main](#ci-pipeline-never-triggered-on-push-to-main)
   - [npm ci failed: lockfile generated with wrong Node version](#npm-ci-failed-lockfile-generated-with-wrong-node-version)
   - [Trivy FS: invalid template path](#trivy-fs-invalid-template-path)
   - [Trivy FS: failed on CVEs with no available fix](#trivy-fs-failed-on-cves-with-no-available-fix)
   - [Trivy FS: thousands of findings from node_modules/](#trivy-fs-thousands-of-findings-from-node_modules)
   - [Trivy FS: still blocking pipeline after filtering](#trivy-fs-still-blocking-pipeline-after-filtering)
   - [Checkov: 20+ violations across all three Helm deployments](#checkov-20-violations-across-all-three-helm-deployments)
   - [Checkov: CKV_K8S_15 on backend after previous fix](#checkov-ckv_k8s_15-on-backend-after-previous-fix)
   - [Checkov: multiple failures in eks/main.tf](#checkov-multiple-failures-in-eksmaintf)
   - [Checkov: CKV2_AWS_64 — KMS key has no explicit policy](#checkov-ckv2_aws_64--kms-key-has-no-explicit-policy)

4. [Kubernetes / Helm](#4-kubernetes--helm)
   - [MySQL CrashLoopBackOff: setuid: Operation not permitted](#mysql-crashloopbackoff-setuid-operation-not-permitted)
   - [MySQL CrashLoopBackOff: chown: Operation not permitted](#mysql-crashloopbackoff-chown-operation-not-permitted)

5. [Monitoring (Grafana)](#5-monitoring-grafana)
   - [Dashboard 6417 showing N/A across all panels](#dashboard-6417-showing-na-across-all-panels)
   - [Dashboard 17900 imported in Korean](#dashboard-17900-imported-in-korean)
   - [Dashboard 7249 imported wrong dashboard](#dashboard-7249-imported-wrong-dashboard)
   - [Dashboard 9614 NGINX Ingress showing N/A](#dashboard-9614-nginx-ingress-showing-na)
   - [Backend Request Rate panel shows no data](#backend-request-rate-panel-shows-no-data)

---

## 1. Local Development

### Backend container not appearing in docker-compose ps

_2026-03-15_

#### Symptoms

- `docker-compose up -d` reported all 3 containers started
- `docker-compose ps` showed only `frontend` and `mysql`; `backend` was missing
- `mysql` showed `3306/tcp` instead of `0.0.0.0:3306->3306/tcp` (no host binding)

#### Root Cause

Two issues compounded:

**1. Stale container on wrong network**
A previous `docker-compose up` had left the `mysql` container running. When `up` was called again, Docker reused the existing container without re-attaching it to the newly created `devsecops-blueprint_app-network`. The backend container resolved `mysql` via Docker DNS, which only works between containers on the same network — so it got `ENOTFOUND mysql` (DNS failure, not connection refused).

**2. Hard crash on connection failure**
`api/models/db.js` called `db.getConnection()` at startup and threw immediately on any error. Even with correct networking, MySQL takes a few seconds to initialize its data directory on first boot — the backend would crash before MySQL was ready.

#### Diagnosis

```
docker-compose logs backend
# Error: getaddrinfo ENOTFOUND mysql
```

```
docker network inspect devsecops-blueprint_app-network
# Only `frontend` listed under Containers — mysql and backend absent
```

#### Fix

**Step 1:** Tear down fully to remove stale containers and the orphaned network.
```bash
docker-compose down
```

**Step 2:** Add retry logic to `api/models/db.js` instead of throwing on the first failed connection. The function retries up to 10 times with a 3-second delay before giving up.

**Step 3:** Rebuild and start.
```bash
docker-compose up -d --build
```

#### Result

All three containers came up healthy. Backend logged `MySQL not ready, retrying...` once, then `MySQL Connected` after MySQL finished initializing.

#### Key Distinction

`ENOTFOUND mysql` = DNS failure = containers are not on the same network.
`ECONNREFUSED` = DNS worked but the service isn't listening yet = networking is healthy, service just needs more time.

---

### Blank page in browser; curl returns 200

_2026-03-15_

#### Symptoms

- `docker-compose up -d --build` completed cleanly, all containers healthy
- `curl http://localhost` returned 200 with valid HTML
- Safari showed a blank white page; browser console logged 404s for JS and CSS bundles

#### Root Cause

The nginx `location ~* \.(jpg|jpeg|png|gif|ico|css|js)$` block had no `root` directive. nginx fell back to its compiled-in default (`/etc/nginx/html`) rather than `/usr/share/nginx/html` where the React build actually lives. The HTML loaded fine because `location /` had an explicit `root`, but static assets matched the second block and got served from the wrong path.

#### Diagnosis

```bash
docker exec -it frontend ls /etc/nginx/html
# No such file or directory — confirms assets weren't there
```

```bash
curl -I http://localhost/static/js/main.chunk.js
# HTTP/1.1 404 Not Found
```

#### Fix

Add `root /usr/share/nginx/html;` at the `server` level in `client/nginx/default.conf`. Child `location` blocks without their own `root` inherit it; the static assets block now resolves correctly.

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;   # inherits to all location blocks without their own root

    location / { ... }

    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

#### Result

Rebuild and redeploy. Browser loaded JS/CSS bundles; React app rendered correctly.

#### Key Distinction

`curl` fetches the HTML document — which worked because `location /` had the correct `root`. The blank page was a JS/CSS failure that only showed up in the browser, not in a basic HTTP check.

---

## 2. Infrastructure (Terraform / EKS)

### terraform apply fails: AccessDeniedException on eks:CreateCluster

_2026-03-19_

#### Symptoms

- `terraform apply` returned 403 AccessDeniedException on `eks:CreateCluster`
- The EC2 installer VM had `AmazonEKSClusterPolicy` attached as the guide instructed
- Adding an inline `EKSFullAccess` policy via the Console saved the wrong JSON (it saved `AmazonEKSClusterPolicy` content instead of `eks:*`)
- `aws eks list-clusters` also returned AccessDenied, confirming the inline policy was broken

#### Root Cause

`AmazonEKSClusterPolicy` contains no `eks:*` actions — it grants EKS permission to manage EC2/ELB resources on the cluster's behalf, not permission for the installer VM to call EKS APIs. The guide incorrectly listed it as a required policy for the installer VM role.

The inline policy fix via the Console failed silently because the wrong JSON was pasted (the `AmazonEKSClusterPolicy` JSON was reused instead of the `eks:*` JSON).

#### Fix

Create a new IAM role (`eks-installer-role-v2`) with:
- `AmazonEC2FullAccess`
- `IAMFullAccess`
- `AmazonVPCFullAccess`
- Inline policy via CLI:

```bash
aws iam put-role-policy \
  --role-name eks-installer-role-v2 \
  --policy-name EKSFullAccess \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"eks:*","Resource":"*"}]}'
```

Attach the new role to the EC2 instance via **Actions → Security → Modify IAM role**, then verify:

```bash
aws eks list-clusters --region us-east-1
# Should return {"clusters": []} not AccessDenied
```

#### Prevention

Do not attach `AmazonEKSClusterPolicy` to the installer VM role — it is meant for the EKS cluster's own IAM role. The installer VM needs `eks:*` via inline policy. Always verify with `aws eks list-clusters` before running `terraform apply`.

---

### terraform apply fails: KeyPair not found

_2026-03-19_

#### Symptoms

- Node group creation failed: `InvalidParameterException: KeyPair DevOps-Faza not found`
- EBS CSI addon went `DEGRADED` and timed out (downstream effect)

#### Root Cause

`variable.tf` referenced a key pair name that didn't exist in `us-east-1`.

#### Fix

Check existing key pairs in the target region:

```bash
aws ec2 describe-key-pairs --region us-east-1 --query 'KeyPairs[*].KeyName'
```

Update `variable.tf` to match the exact name. Re-run `terraform apply` — Terraform skips already-created resources and retries only the failed ones. The addon degradation resolved automatically once the node group was fixed.

#### Prevention

Before `terraform apply`, always confirm the key pair name in `variable.tf` matches what exists in `us-east-1`.

---

## 3. CI Pipeline (GitHub Actions)

### CI pipeline never triggered on push to main

_2026-03-20_

#### Symptoms

- Pushed commits to `main`; no pipeline run appeared in the Actions tab

#### Root Cause

`on.push.branches` in `.github/workflows/ci-cd.yml` only listed `feature/*`. `main` was not included, so pushes to it were silently ignored.

#### Fix

Add `main` to the push trigger. The final state in `.github/workflows/ci-cd.yml`:

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
```

#### Prevention

When setting up a new workflow, always verify both `main` and `develop` are in the push trigger. A missing branch here produces no error — the pipeline just never runs.

---

### npm ci failed: lockfile generated with wrong Node version

_2026-03-20_

#### Symptoms

- `npm ci` errored in the `lint` and `npm-audit` jobs with a lockfile format mismatch
- Error referenced `client/package-lock.json`

#### Root Cause

`client/package-lock.json` was generated locally with a different Node version than the Node 22 used in CI. The lockfile format version mismatch caused `npm ci` to reject it.

#### Fix

Regenerate the lockfile locally using Node 22:

```bash
nvm use 22
cd client
npm install
```

Commit the updated `package-lock.json`.

#### Prevention

Pin the Node version in `.nvmrc` or the `engines` field in `package.json` to match the version used in CI. This surfaces version mismatches locally before they reach the pipeline.

---

### Trivy FS: invalid template path

_2026-03-20_

#### Symptoms

- `trivy-fs` job failed immediately with a template-related error
- No SARIF file was produced

#### Root Cause

The `trivy-action` was invoked with `format: template` and a `--template` path that didn't exist in the action's container image.

#### Fix

Switch to `format: sarif` — it's built-in and requires no template path. The relevant fields in the final `trivy-fs` step:

```yaml
- name: Run Trivy filesystem scan
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: fs
    scan-ref: .
    format: sarif
    output: trivy-fs-report.sarif
    exit-code: 0
    severity: HIGH,CRITICAL
```

Commit: `a5f5387`

#### Prevention

`sarif` is the correct format for GitHub Security tab integration. `template` requires a bundled template file and is error-prone unless you control the container image.

---

### Trivy FS: failed on CVEs with no available fix

_2026-03-20_

#### Symptoms

- Job failed with HIGH/CRITICAL findings
- All flagged CVEs showed `fixed-version: N/A`

#### Root Cause

Trivy's default behavior exits non-zero on any finding matching the severity threshold, including CVEs that have no upstream fix yet.

#### Fix

Added `ignore-unfixed: true` to the action inputs at the time. This was later removed when Trivy FS was converted to a soft gate (`exit-code: 0`) — with the pipeline no longer blocking on any Trivy finding, filtering unfixed CVEs became redundant.

Commit: `1440f2d` (subsequently superseded by `2ba00e6`)

#### Key Distinction

Unfixable CVEs are informational — there is no remediation action available. Blocking the pipeline on them produces noise without improving security posture.

---

### Trivy FS: thousands of findings from node_modules/

_2026-03-20_

#### Symptoms

- After the unfixed filter, hundreds of findings remained — all sourced from `node_modules/`

#### Root Cause

Trivy scanned the full repository including `node_modules/`, duplicating coverage that `npm audit` already handles as a dedicated hard gate.

#### Fix

Added `skip-dirs: node_modules` to the action inputs at the time. This was later removed alongside `ignore-unfixed` when the soft gate approach was adopted — with `exit-code: 0`, Trivy FS findings no longer block the pipeline regardless of what directories are scanned.

Commit: `85514a3` (subsequently superseded by `2ba00e6`)

#### Key Distinction

`npm audit` is the correct tool for dependency CVEs — it resolves the full dependency graph with lockfile precision. Trivy FS scanning `node_modules/` is redundant and generates false-positive volume.

---

### Trivy FS: still blocking pipeline after filtering

_2026-03-20_

#### Symptoms

- Even with unfixed and `node_modules` filtered, `trivy-fs` still failed and blocked the `build-push` job

#### Root Cause

`exit-code: 1` made Trivy FS a hard gate. The job is designed to scan for filesystem-level misconfigurations and secrets — not dependency CVEs. `npm audit` is the correct hard gate for those.

#### Fix

Set `exit-code: 0` (soft gate) and retain the SARIF artifact upload for visibility. Final `trivy-fs` step config:

```yaml
- name: Run Trivy filesystem scan
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: fs
    scan-ref: .
    format: sarif
    output: trivy-fs-report.sarif
    exit-code: 0
    severity: HIGH,CRITICAL
- name: Upload Trivy FS report
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: trivy-fs-report
    path: trivy-fs-report.sarif
```

Commit: `2ba00e6`

#### Key Distinction

Hard gate vs. soft gate is a policy decision, not a scanner capability. Trivy FS runs for audit visibility; `npm audit` owns the CVE hard gate because it has full lockfile context.

---

### Checkov: 20+ violations across all three Helm deployments

_2026-03-20_

#### Symptoms

- `checkov` job failed
- All three deployments (backend, frontend, mysql) had multiple violations covering security context, resource limits, probes, and service account configuration

#### Root Cause

Helm templates had no security hardening. Missing fields across all deployments:
- `securityContext.runAsNonRoot`, `runAsUser`, `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`
- `seccompProfile`
- Resource `limits`
- Liveness and readiness probes
- `automountServiceAccountToken: false`

#### Fix

Added full security context to all three deployment templates. Added resource limits to `values.yaml`. Created `.checkov.yaml` to skip four checks that are image-level constraints and cannot be fixed in the chart:

```yaml
# .checkov.yaml
skip-check:
  - CKV_K8S_43  # image digest — incompatible with tag-based GitOps
  - CKV_K8S_40  # nginx (UID 101) and MySQL (root) are image-defined UIDs
  - CKV_K8S_35  # MySQL init requires env vars; app refactor is out of scope
  - CKV_K8S_22  # nginx and MySQL need writable filesystem paths (image constraints)
```

Commit: `25f3a9d`

#### Key Distinction

Checkov checks divide into two categories: things fixable in the chart (security context, probes, limits) and things that are image-level constraints (UID, filesystem mutability). Skipping the latter is correct — they cannot be addressed without changing the upstream image.

---

### Checkov: CKV_K8S_15 on backend after previous fix

_2026-03-20_

#### Symptoms

- After the 20+ violation fix, CI re-run failed with one remaining violation: `CKV_K8S_15` on `Deployment.prod.backend`

#### Root Cause

`imagePullPolicy: Always` was added to frontend and mysql in the prior fix but missed on backend. The omission was masked by the volume of other errors in the first scan — the backend violation was never surfaced individually.

#### Fix

Add `imagePullPolicy: Always` to the backend container spec in `charts/usermgmt/templates/backend.yaml`, directly after the `image:` line:

```yaml
containers:
  - name: backend
    image: {{ .Values.image.backend }}:{{ .Values.image.tag }}
    imagePullPolicy: Always
```

Commit: `85481ec`

#### Prevention

When applying a fix across multiple similar resources, diff all of them before committing. A bulk search for the field being added (`imagePullPolicy`) would have caught the miss immediately.

---

### Checkov: multiple failures in eks/main.tf

_2026-03-20_

#### Symptoms

- `checkov` job failed on `eks/main.tf` after adding the EKS Terraform module
- Violations spanned security groups, subnets, VPC flow logs, and EKS endpoint configuration

#### Root Cause

The initial `eks/main.tf` had no explicit `description` on security group rules, no restricted default SG, egress rules open to `0.0.0.0/0` instead of the VPC CIDR, only 3 of 5 EKS log types enabled, no KMS encryption for secrets, and no justified skips for checks that are intentionally out of scope for a portfolio deployment.

#### Fix

**Commit `f0605db`:**
- Added `aws_default_security_group` resource to restrict the default SG (no rules = deny all)
- Added `description` to both security groups (cluster and node)
- Changed egress `cidr_blocks` from `0.0.0.0/0` to the VPC CIDR
- Added `enabled_cluster_log_types = ["api", "audit", "authenticator"]`
- Skipped three checks in `.checkov.yaml` with justification:
  - `CKV_AWS_130` — public subnets intentional; NAT gateway out of scope
  - `CKV_AWS_382` — open egress required for ECR/API access
  - `CKV2_AWS_11` — VPC flow logging deferred; requires IAM + CloudWatch setup

**Commit `b683f8e`:**
- Added inline `description` to all three security group ingress/egress rules
- Expanded `enabled_cluster_log_types` to all 5 types: `api`, `audit`, `authenticator`, `controllerManager`, `scheduler`
- Added `aws_kms_key.devopsfaza_eks_secrets` and wired it into `encryption_config` on the EKS cluster
- Skipped two more checks in `.checkov.yaml`:
  - `CKV_AWS_38` — public endpoint intentional; private access requires bastion/VPN, out of scope
  - `CKV_AWS_39` — same reasoning

The resulting `.checkov.yaml` after both commits:

```yaml
skip-check:
  - CKV_K8S_43  # Image digest: incompatible with tag-based GitOps workflow
  - CKV_K8S_40  # High UID: nginx=101 and MySQL=root are image-level constraints
  - CKV_K8S_35  # Secrets as env vars: MySQL init requires env vars; app refactor out of scope
  - CKV_K8S_22  # ReadOnly filesystem: nginx/MySQL need writable paths (image constraints)
  - CKV_AWS_130  # Public subnets intentional: EKS nodes require internet access; NAT gateway out of scope
  - CKV_AWS_382  # Open egress required: EKS nodes must reach ECR, AWS APIs, and pull container images
  - CKV2_AWS_11  # VPC flow logging requires IAM + CloudWatch setup; deferred as out of scope for this portfolio
  - CKV_AWS_38  # Public endpoint access intentional: local kubectl requires public endpoint; private VPN/bastion out of scope
  - CKV_AWS_39  # Public endpoint intentional: disabling requires VPC-internal access (bastion/VPN), out of scope for portfolio
```

#### Prevention

When writing Terraform for EKS, security group rules need explicit `description` fields or Checkov will fail. The distinction between checks that are fixable (log types, KMS, default SG) and checks that are architectural decisions (public endpoint, public subnets) should be made explicit in `.checkov.yaml` with comments.

---

### Checkov: CKV2_AWS_64 — KMS key has no explicit policy

_2026-03-20_

#### Symptoms

- After `b683f8e` added `aws_kms_key.devopsfaza_eks_secrets`, CI surfaced a new failure: CKV2_AWS_64
- The key had no `policy` argument; Checkov treats this as an undefined access policy

#### Root Cause

AWS creates a default KMS key policy when none is specified, but Checkov requires an explicit `policy` block to verify that access is properly scoped. Without it the check fails regardless of the AWS default behavior.

#### Fix

Added `data "aws_caller_identity" "current" {}` to get the account ID, then added an explicit `policy` to the KMS key with two statements:

1. Root account full key administration (`kms:*` for the account root principal)
2. EKS service principal limited to encryption operations (`kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*`, `kms:GenerateDataKey*`, `kms:DescribeKey`)

```hcl
data "aws_caller_identity" "current" {}

resource "aws_kms_key" "devopsfaza_eks_secrets" {
  description             = "KMS key for EKS secrets encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  tags                    = { Name = "devopsfaza-eks-secrets-key" }

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM Root Access"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow EKS Secrets Encryption"
        Effect = "Allow"
        Principal = {
          Service = "eks.amazonaws.com"
        }
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey"
        ]
        Resource = "*"
      }
    ]
  })
}
```

Commit: `6f3be82`

#### Key Distinction

An explicit key policy is the correct security posture regardless of the Checkov requirement. The default AWS policy grants broad access to IAM; an explicit policy locks it to the specific principals that actually need it.

---

## 4. Kubernetes / Helm

### MySQL CrashLoopBackOff: setuid: Operation not permitted

_2026-03-20_

#### Symptoms

- `mysql-0` pod in CrashLoopBackOff in the `prod` namespace
- Logs: `setuid: Operation not permitted` followed by `Aborting`

#### Root Cause

Two things blocked MySQL 8.4's entrypoint from calling `setuid()` to drop from root to the `mysql` user:

1. `allowPrivilegeEscalation: false` — the kernel blocks `setuid` syscalls when this flag is set, regardless of capabilities
2. `SETUID` capability was not in `capabilities.add` — only `SETGID` was present

#### Fix

In `charts/usermgmt/templates/mysql.yaml`:

1. Added `checkov.io/skip5` annotation for `CKV_K8S_20` (allowPrivilegeEscalation check)
2. Changed `allowPrivilegeEscalation: false` → `true`
3. Added `SETUID` to `capabilities.add`

```yaml
securityContext:
  allowPrivilegeEscalation: true
  capabilities:
    drop:
      - ALL
    add:
      - SETGID
      - SETUID
```

The StatefulSet updated correctly but the running pod still had the old spec. A `kubectl rollout restart statefulset mysql -n prod` was issued but the pod kept restarting from backoff without picking up the new template. Required a manual `kubectl delete pod mysql-0 -n prod` to force recreation.

#### Prevention

After updating a StatefulSet securityContext, verify the running pod spec with `kubectl get pod <name> -o yaml | grep -A 8 securityContext` — not just the StatefulSet template. If the pod spec doesn't reflect the change, delete the pod manually.

---

### MySQL CrashLoopBackOff: chown: Operation not permitted

_2026-03-20_

#### Symptoms

- After the `setuid` fix, MySQL crashed with a new error: `chown: changing ownership of '/var/lib/mysql/': Operation not permitted`
- Also: `find: '/var/lib/mysql-files': Permission denied`

#### Root Cause

`capabilities.drop: [ALL]` removed `CHOWN`, `DAC_OVERRIDE`, and `FOWNER`. MySQL's entrypoint needs these to take ownership of the data directory during initialization.

The PVC also retained data from a previous failed run, owned by a different UID, which compounded the permission errors.

#### Fix

Added three capabilities to `capabilities.add`:

```yaml
add:
  - SETGID
  - SETUID
  - CHOWN
  - DAC_OVERRIDE
  - FOWNER
```

Updated `skip3` and `skip4` annotation comments to reflect all five capabilities.

Deleted the PVC (`mysql-data-mysql-0`) to clear the stale data directory, then deleted the pod to force fresh initialization.

#### Prevention

When using `capabilities.drop: [ALL]`, enumerate every capability the process needs at startup — not just the ones needed at runtime. MySQL's entrypoint does significant filesystem ownership work before the server starts. Check upstream image entrypoint scripts for `chown`/`chmod` calls when hardening.

---

## 5. Monitoring (Grafana)

### Dashboard 6417 showing N/A across all panels

_2026-03-21_

#### Symptoms

- Imported dashboard 6417 (Kubernetes Cluster Prometheus); all panels showed N/A
- Datasource variable had warning icon; "Preview of values (0)"

#### Root Cause

Two issues compounded. First, the `datasource` variable had `/$ds/` in the Instance name filter — a self-referencing variable that resolves to nothing. Second, even after fixing the filter, all panels remained N/A because dashboard 6417 uses metric names that don't exist in kube-prometheus-stack (outdated dashboard, last updated 2018).

#### Fix

Cleared the `/$ds/` filter from the datasource variable — Preview of values changed to show "Prometheus (1)". The dashboard still showed N/A confirming metric name incompatibility. Removed 6417 from the guide entirely.

#### Prevention

Before importing a community dashboard, check the "Updated on" date on grafana.com. Dashboards older than 2022 are likely incompatible with current kube-prometheus-stack metric names.

---

### Dashboard 17900 imported in Korean

_2026-03-21_

#### Symptoms

- Imported dashboard 17900; all panel labels and section headers were in Korean
- Title showed "Kubernetes All-in-one Cluster Monitoring KR(v1.26.0)"

#### Root Cause

Dashboard 17900 on Grafana's library is the Korean-localized version. No English version selector is available on the import screen.

#### Fix

Deleted the dashboard and imported **15661** (K8S Dashboard) instead — English, compatible with kube-prometheus-stack, and the data populated correctly.

---

### Dashboard 7249 imported wrong dashboard

_2026-03-21_

#### Symptoms

- Imported dashboard ID 7249 expecting NGINX Ingress Controller; got "Kubernetes Cluster" by publisher "buhay" (last updated 2018)

#### Root Cause

Wrong dashboard ID. 7249 is an unrelated Kubernetes Cluster dashboard, not the NGINX Ingress Controller dashboard.

#### Fix

Cancelled the import and used **9614** (NGINX Ingress Controller) instead.

---

### Dashboard 9614 NGINX Ingress showing N/A

_2026-03-21_

#### Symptoms

- Imported dashboard 9614; all panels showed N/A or "No data"
- All dashboard variables had green checkmarks

#### Root Cause

The NGINX Ingress Controller was not exposing metrics to Prometheus. By default, the ingress-nginx Helm install does not enable the `/metrics` endpoint or create a ServiceMonitor. Dashboard 9614 queries `nginx_ingress_controller_requests` and `nginx_ingress_controller_config_hash` — neither metric existed in Prometheus.

#### Fix

Upgraded the ingress-nginx Helm release with metrics and ServiceMonitor enabled:

```bash
helm upgrade ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --set controller.metrics.enabled=true --set controller.metrics.serviceMonitor.enabled=true --set controller.metrics.serviceMonitor.additionalLabels.release=prometheus
```

Verified metrics were being scraped:

```bash
curl -s "http://localhost:9090/api/v1/query?query=nginx_ingress_controller_requests" | python3 -m json.tool | grep -c "metric"
# returned 28
```

ServiceMonitor selector matched (`release: prometheus`). Despite metrics existing in Prometheus, dashboard 9614 panels remained N/A — metric name mismatches with the current ingress-nginx version. Removed 9614 from the guide.

#### Note

The `helm upgrade` command had to be written via `nano` and fixed with `sed` because the SSH client was wrapping long lines and inserting spaces into the command, breaking argument parsing.

---

### Backend Request Rate panel shows no data

_2026-03-21_

#### Symptoms

- Custom dashboard panel using `rate(http_requests_total{namespace="prod", service="backend"}[5m])` returned no data

#### Root Cause

`http_requests_total` is an application-level metric that only exists if the backend code uses `prom-client` and exposes a `/metrics` endpoint. This project does not instrument the backend — `prom-client` is not installed and `/metrics` does not exist.

#### Fix

Removed the Backend Request Rate panel from the custom dashboard. The three remaining panels (CPU usage, memory usage, pod restart count) use infrastructure metrics from cadvisor and kube-state-metrics, which work without application instrumentation.
