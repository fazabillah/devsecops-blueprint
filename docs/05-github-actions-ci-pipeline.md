# Day 5: GitHub Actions CI Pipeline

**Branch:** `feature/ci`

## Why GitHub Actions

Jenkins requires a VM, a running service, and manual credential setup. GitHub Actions runs in GitHub's infrastructure with no server to provision or maintain. Secrets, tokens, and PR checks are native — wired directly into the repository. Jobs run on GitHub-hosted runners (`ubuntu-latest`), which are free for public repos.

Most companies default to GitHub Actions for new projects. It appears most often in job listings for engineers under five years of experience.

---

## Branching Strategy

This project follows Git Flow. Understanding the branch model matters because the pipeline triggers are wired to specific branches.

- `main` — production-ready code only. Protected branch. No direct push. Merges come from `develop` via PR after manual review.
- `develop` — integration branch. All feature work merges here. Every push to `develop` triggers the full CI pipeline.
- `feature/*` — all day-to-day work. Branch off `develop`, merge back to `develop` via PR. Name branches as `feature/what-you-are-building` (e.g. `feature/multi-stage-docker`, `feature/helm-chart`).
- `fix/*` — bug fixes on `develop`. Same flow as feature branches.
- `hotfix/*` — production-only. Branches off `main` directly for urgent fixes, merged back to both `main` and `develop`.

In a team, no direct push to `develop` or `main` — everything goes through a PR. When learning solo, direct push to `develop` is fine.

---

## How Workflows Work

A workflow is a YAML file in `.github/workflows/`. It runs on events you define (`push`, `pull_request`, etc.). Each workflow has jobs, each job has steps.

Jobs run in parallel by default. Use `needs:` to make a job wait for another. This pipeline uses parallel groups to maximize speed while preserving gate ordering.

You will create `.github/workflows/ci-cd.yml` in the next section.

**Triggers:**
- `push` on `main` and `develop` — runs the full pipeline when code lands on either branch
- `pull_request` on `main` — runs on PRs targeting main

---

## Repository Secrets Setup

**[GitHub — repo Settings → Secrets and variables → Actions]**

Create these five repository secrets before running the pipeline:

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Your DockerHub username |
| `DOCKERHUB_TOKEN` | DockerHub access token (not your password) |
| `SONAR_TOKEN` | SonarCloud project token |
| `SONAR_HOST_URL` | `https://sonarcloud.io` |
| `GH_PAT` | GitHub Personal Access Token with `repo` write scope |

To create a DockerHub access token: DockerHub → Account Settings → Security → New Access Token.

To create a GitHub PAT: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Fill in a token name (e.g. `devsecops-blueprint-ci`), set expiration to 90 days, set Repository access to "Only select repositories" and pick your repo. Under Repository permissions, set **Contents** to Read and write. Everything else stays at No access. Copy the token immediately after generating — it won't be shown again. Add it as `GH_PAT` in GitHub Secrets.

`GH_PAT` is needed because the default `GITHUB_TOKEN` cannot push commits that trigger subsequent workflow runs. A PAT bypasses this restriction.

---

# Application Setup (Before the First Run)

The pipeline expects `npm run lint` to exist in both `api/` and `client/`. These aren't in the repo by default — create them now.

### Step 1 — ESLint for the backend

**[Local Machine — `api/` directory]**

Create `api/eslint.config.js` (ESLint 9 uses flat config — `.eslintrc.json` is the old format):

```js
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-console": "off",
    },
  },
];
```

Using `globals.node` instead of listing individual globals covers the full Node.js built-in set — `setTimeout`, `Buffer`, `URL`, etc. The `globals` package ships with ESLint 9, no separate install needed.

Edit `api/package.json` — add `lint` to scripts and ESLint 9 to devDependencies:

```json
"scripts": {
  "start": "node app.js",
  "lint": "eslint ."
},
"devDependencies": {
  "eslint": "^9.0.0",
  "@eslint/js": "^9.0.0"
}
```

### Step 2 — ESLint for the frontend

`react-scripts` already bundles ESLint, so no new dependency is needed. Edit `client/package.json` — add `lint` to scripts:

```json
"lint": "eslint src/ --ext .js,.jsx"
```

### Step 3 — sonar-project.properties

Create `sonar-project.properties` at the repo root (not inside `api/` or `client/`):

```properties
sonar.projectKey=NodeJS-Project
sonar.organization=fazabillah
sonar.sources=api,client
sonar.exclusions=**/node_modules/**,**/coverage/**,**/build/**
```

This makes the SonarCloud config explicit and portable — the scanner picks it up without needing `-D` flags in the workflow.

### Verify locally before pushing

```bash
# ESLint — should pass or show warnings only (no errors)
cd api && npm install && npm run lint
cd ../client && npm install && npm run lint

# npm audit — run for both api and client
# The pipeline's npm-audit job runs a matrix over both directories
cd api && npm audit --audit-level=high
# Expected: found 0 vulnerabilities

cd ../client && npm audit --audit-level=critical
# client uses --audit-level=critical (not high) because react-scripts has unfixable
# HIGH CVEs in its build toolchain that don't reach the production bundle.
# Run npm audit fix first to resolve what can be safely fixed.
# Expected: found 0 vulnerabilities at critical severity

# Hadolint — install once, then lint both Dockerfiles
brew install hadolint
hadolint api/Dockerfile
hadolint client/Dockerfile
```

Note: use `npm install` instead of `npm ci` when you've just added new devDependencies (like ESLint) to `package.json` — `npm ci` requires the lock file to already reflect those packages. Run `npm install` first to update the lock file, then `npm ci` works in the pipeline.

---

# Files to Create

One file is needed in this section:

- `.github/workflows/ci-cd.yml` — the pipeline definition. All 10 jobs live inside this single file.

Create the directory if it doesn't exist:

```bash
mkdir -p .github/workflows
```

Then create `.github/workflows/ci-cd.yml` with the full content below.

---

# Complete ci-cd.yml

Copy this file exactly. The Workflow Walkthrough section below explains what each job does.

```yaml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  IMAGE_TAG: ${{ github.sha }}

jobs:
  # Job 1: ESLint — code quality check for api and client
  lint:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        dir: [api, client]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: cd ${{ matrix.dir }} && npm ci && npm run lint

  # Job 2: npm audit — dependency CVE scan
  # Uses matrix include to set per-directory audit levels:
  # api uses --audit-level=high; client uses --audit-level=critical
  # (react-scripts has unfixable HIGH CVEs in its build toolchain)
  npm-audit:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - dir: api
            audit_level: high
          - dir: client
            audit_level: critical
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - run: cd ${{ matrix.dir }} && npm audit --audit-level=${{ matrix.audit_level }}

  # Job 3: Gitleaks — secret scanning
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  # Job 4: Hadolint — Dockerfile best-practice linting
  hadolint:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        dockerfile: [api/Dockerfile, client/Dockerfile]
    steps:
      - uses: actions/checkout@v4
      - uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: ${{ matrix.dockerfile }}

  # Job 5: SonarCloud — static analysis (gates on jobs 1-4)
  sonarqube:
    runs-on: ubuntu-latest
    needs: [lint, npm-audit, gitleaks, hadolint]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: SonarSource/sonarcloud-github-action@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}

  # Job 6: Trivy filesystem scan — broad vulnerability scan before build
  trivy-fs:
    runs-on: ubuntu-latest
    needs: [lint, npm-audit, gitleaks, hadolint]
    steps:
      - uses: actions/checkout@v4
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

  # Job 7: Docker build and push (gates on jobs 5-6)
  build-push:
    runs-on: ubuntu-latest
    needs: [sonarqube, trivy-fs]
    strategy:
      matrix:
        include:
          - context: api
            image: fazabillah/backend
          - context: client
            image: fazabillah/frontend
    steps:
      - uses: actions/checkout@v4
      - name: Log in to DockerHub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: ${{ matrix.context }}
          push: true
          tags: ${{ matrix.image }}:${{ env.IMAGE_TAG }}

  # Job 8: Trivy image scan — soft gate (exit-code: 0 keeps pipeline running)
  # Switch to exit-code: 1 when operating in a team with a remediation process
  trivy-image:
    runs-on: ubuntu-latest
    needs: build-push
    strategy:
      matrix:
        include:
          - image: fazabillah/backend
          - image: fazabillah/frontend
    steps:
      - uses: actions/checkout@v4
      - name: Run Trivy image scan
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: image
          image-ref: ${{ matrix.image }}:${{ env.IMAGE_TAG }}
          format: sarif
          output: trivy-image-report-${{ matrix.image == 'fazabillah/backend' && 'backend' || 'frontend' }}.sarif
          exit-code: 0
          severity: HIGH,CRITICAL
      - name: Upload Trivy image report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: trivy-image-report-${{ matrix.image == 'fazabillah/backend' && 'backend' || 'frontend' }}
          path: trivy-image-report-${{ matrix.image == 'fazabillah/backend' && 'backend' || 'frontend' }}.sarif

  # Job 9: Checkov — IaC scan: Helm chart + Terraform (parallel with trivy-image)
  checkov:
    runs-on: ubuntu-latest
    needs: build-push
    steps:
      - uses: actions/checkout@v4
      - name: Install Checkov
        run: pip install checkov
      - name: Checkov Helm scan
        run: checkov -d charts/usermgmt --framework helm
      - name: Checkov Terraform scan
        run: checkov -d eks --framework terraform

  # Job 10: Update values.yaml with new image tag (gates on jobs 8-9)
  update-manifest:
    runs-on: ubuntu-latest
    needs: [trivy-image, checkov]
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GH_PAT }}
      - name: Update image tag in values.yaml
        run: |
          IMAGE_TAG=$(git rev-parse --short HEAD)
          sed -i "s|tag:.*|tag: \"${IMAGE_TAG}\"|" charts/usermgmt/values.yaml
      - name: Commit and push
        run: |
          IMAGE_TAG=$(git rev-parse --short HEAD)
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add charts/usermgmt/values.yaml
          git diff --cached --quiet || git commit -m "ci: update image tag to ${IMAGE_TAG} [skip ci]"
          git push
```

---

# Pipeline Overview (10-job DAG)

```
Job 1:  lint           — ESLint (matrix: api + client)
Job 2:  npm-audit      — SCA: dependency CVE scan (matrix: api + client)
Job 3:  gitleaks       — Secret scanning
Job 4:  hadolint       — Dockerfile best-practice linting (matrix: api + client)
         ↓ (all four must pass)
Job 5:  sonarqube      — Static analysis via SonarCloud
Job 6:  trivy-fs       — Filesystem scan, SARIF report as artifact
         ↓ (both must pass)
Job 7:  build-push     — Docker build + push (matrix: backend + frontend)
         ↓
Job 8:  trivy-image    — Image scan, fails on HIGH/CRITICAL CVEs
Job 9:  checkov        — IaC scan: Helm chart + Terraform (parallel with trivy-image)
         ↓ (both must pass)
Job 10: update-manifest — Commits updated image tag to values.yaml
```

Jobs 1–4 run in parallel — all are static analysis with no dependencies between them. Jobs 5–6 gate on all four passing. Job 7 only builds after both security scans clear. Jobs 8–9 run in parallel after the build. Job 10 closes the GitOps loop.

ArgoCD watches `charts/usermgmt/values.yaml`. When Job 10 commits a new tag there, ArgoCD detects the drift and auto-syncs. See Day 06 for ArgoCD setup.

---

# Workflow Walkthrough

The full workflow is in `.github/workflows/ci-cd.yml` (the file you just created). This section explains each job by number, matching the DAG diagram above.

### Trigger

```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
```

### Job 1 — lint (ESLint)

Replaces the old `node --check` syntax check. `node --check` only catches parse errors — ESLint catches undefined variables, bad patterns, and anything configured in `.eslintrc.json`.

```yaml
lint:
  strategy:
    matrix:
      dir: [api, client]
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: "22" }
    - run: cd ${{ matrix.dir }} && npm ci && npm run lint
```

### Job 2 — npm-audit

SCA (Software Composition Analysis). Checks every package in `node_modules` against the npm advisory database for known CVEs. `--audit-level=high` exits non-zero only on HIGH or CRITICAL findings, ignoring low/moderate noise.

The job uses `matrix: include` to assign different audit levels per directory. `api` uses `--audit-level=high` because its dependencies don't carry the react-scripts build tool baggage. `client` uses `--audit-level=critical` to avoid failing on unfixable HIGH CVEs inside `react-scripts` — see the Troubleshooting section for detail.

```yaml
npm-audit:
  strategy:
    matrix:
      include:
        - dir: api
          audit_level: high
        - dir: client
          audit_level: critical
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: "22" }
    - run: cd ${{ matrix.dir }} && npm audit --audit-level=${{ matrix.audit_level }}
```

This is different from Trivy FS scan. Trivy checks OS packages, binaries, and lockfiles broadly. npm audit queries the npm advisory database specifically, which has advisories Trivy may not carry.

### Job 3 — gitleaks

Scans every commit in the push for accidentally committed secrets — API keys, tokens, passwords, private keys. Runs against the full git history (`fetch-depth: 0`) so it catches secrets that were added and removed in earlier commits, not just the latest diff.

```yaml
gitleaks:
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - uses: gitleaks/gitleaks-action@v2
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Gitleaks uses pattern matching against a built-in ruleset covering AWS keys, GitHub tokens, Stripe keys, and hundreds of other formats. If it flags a false positive, you can add a `.gitleaks.toml` at the repo root to allow specific patterns.

### Job 4 — hadolint

Lints both Dockerfiles for best-practice violations before anything gets built. Common findings: `COPY` running as root, missing `--no-install-recommends` on apt installs, unpinned base image tags, `ADD` used instead of `COPY`.

```yaml
hadolint:
  strategy:
    matrix:
      dockerfile: [api/Dockerfile, client/Dockerfile]
  steps:
    - uses: actions/checkout@v4
    - uses: hadolint/hadolint-action@v3.1.0
      with:
        dockerfile: ${{ matrix.dockerfile }}
```

### Job 5 — sonarqube

Static analysis via SonarCloud. Scans source code for bugs, code smells, and security hotspots across both `api/` and `client/`. Gates on all four parallel jobs passing first.

The scanner reads `sonar-project.properties` at the repo root — no `-D` flags needed in the workflow step. `fetch-depth: 0` is required so SonarCloud can compare against the base branch for new code analysis.

```yaml
sonarqube:
  needs: [lint, npm-audit, gitleaks, hadolint]
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - uses: SonarSource/sonarcloud-github-action@master
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

### Job 6 — trivy-fs

Filesystem scan — runs Trivy against the repo contents before anything is built. Catches vulnerabilities in lockfiles, OS package lists, and any binaries already in the repo. Saves the report as a downloadable SARIF artifact in the Actions run.

```yaml
trivy-fs:
  needs: [lint, npm-audit, gitleaks, hadolint]
  steps:
    - uses: actions/checkout@v4
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

### Job 7 — build-push

Builds Docker images for `api/` (backend) and `client/` (frontend) and pushes them to DockerHub. Uses `matrix: include` to map each directory to its image name. The image tag is the full commit SHA from `env.IMAGE_TAG`, set at the workflow level.

```yaml
build-push:
  needs: [sonarqube, trivy-fs]
  strategy:
    matrix:
      include:
        - context: api
          image: fazabillah/backend
        - context: client
          image: fazabillah/frontend
  steps:
    - uses: actions/checkout@v4
    - uses: docker/login-action@v3
      with:
        username: ${{ secrets.DOCKERHUB_USERNAME }}
        password: ${{ secrets.DOCKERHUB_TOKEN }}
    - uses: docker/build-push-action@v5
      with:
        context: ${{ matrix.context }}
        push: true
        tags: ${{ matrix.image }}:${{ env.IMAGE_TAG }}
```

### Job 8 — trivy-image

Scans the built Docker images for CVEs. The `exit-code` setting controls whether a finding blocks deployment.

**Soft gate (`exit-code: 0`)** — Trivy runs and uploads the report as an artifact, but the job always passes. The pipeline continues to Job 10 regardless of findings. Use this when you're a solo learner working through the guide, or when a team is introducing security scanning for the first time and hasn't set up a remediation process yet.

**Hard gate (`exit-code: 1`)** — Trivy fails the job on any HIGH or CRITICAL CVE, which blocks Job 10 (no deployment). Use this when a team has a defined remediation SLA and a developer available to fix the finding.

One thing worth being explicit about: fixing a CVE found by Trivy is developer work, not DevSecOps work. The DevSecOps engineer sets the policy, surfaces the finding, and tracks remediation. If you're learning alone with no developer to hand the finding to, running soft gate keeps the pipeline functional while you still see what Trivy produces.

For this project, run soft gate (`exit-code: 0`) on `trivy-image` through Days 1–8. Switch to hard gate when the project is used in a team context with a remediation process in place.

### Job 9 — checkov

IaC static analysis — catches misconfigurations in Helm charts and Terraform before any infrastructure is touched. Runs after `build-push` in parallel with `trivy-image`.

```yaml
checkov:
  needs: build-push
  steps:
    - uses: actions/checkout@v4

    - name: Install Checkov
      run: pip install checkov

    - name: Checkov Helm scan
      run: checkov -d charts/usermgmt --framework helm

    - name: Checkov Terraform scan
      run: checkov -d eks --framework terraform
```

`bridgecrewio/checkov-action` is a wrapper around the same pip package that hasn't been updated since 2022. Installing checkov directly via pip is the standard approach — it uses the actively maintained package and removes the dependency on a stale action. Checkov exits non-zero on any finding by default, which blocks the pipeline. Common Helm findings: missing resource limits, containers running as root, missing readOnly rootFilesystem. Common Terraform findings: unencrypted storage, open security groups, missing logging.

### Matrix Strategy

```yaml
strategy:
  matrix:
    dir: [api, client]
```

This runs the same job twice in parallel — once for `api/`, once for `client/`. For `build-push`, the matrix maps each directory to its image name:

```yaml
matrix:
  include:
    - context: api
      image: fazabillah/backend
    - context: client
      image: fazabillah/frontend
```

Matrix strategy cuts the number of separate job definitions in half.

### Image Tag

```yaml
env:
  IMAGE_TAG: ${{ github.sha }}
```

`github.sha` is the full 40-character commit SHA. The `update-manifest` job uses `git rev-parse --short HEAD` to get the short 7-character version for `values.yaml`.

### Job 10 — update-manifest

```yaml
update-manifest:
  needs: [trivy-image, checkov]
  steps:
    - uses: actions/checkout@v4
      with:
        token: ${{ secrets.GH_PAT }}

    - name: Update image tag in values.yaml
      run: |
        IMAGE_TAG=$(git rev-parse --short HEAD)
        sed -i "s|tag:.*|tag: \"${IMAGE_TAG}\"|" charts/usermgmt/values.yaml

    - name: Commit and push
      run: |
        IMAGE_TAG=$(git rev-parse --short HEAD)
        git config user.name "github-actions[bot]"
        git config user.email "github-actions[bot]@users.noreply.github.com"
        git add charts/usermgmt/values.yaml
        git diff --cached --quiet || git commit -m "ci: update image tag to ${IMAGE_TAG} [skip ci]"
        git push
```

The `[skip ci]` in the commit message tells GitHub Actions not to trigger a new run from this push. Without it, the manifest commit would trigger the pipeline again infinitely.

---

# SonarCloud Setup

SonarCloud is the cloud-hosted version of SonarQube — free for public repos, no server required.

**[SonarCloud.io]**

1. Log in to sonarcloud.io with your GitHub account
2. Create a new organization: choose "Import from GitHub" and select your GitHub username/org. The slug it generates (e.g. `fazabillah`) is your `sonar.organization` value
3. Create a new project: select your repo → Set Up
4. When asked for CI method, you may land directly on an auto-analysis report instead. If that happens, go to **Administration → Analysis Method** (left sidebar) and toggle off **Automatic Analysis** — this unlocks the GitHub Actions setup path
5. Select **GitHub Actions** as the CI method. SonarCloud shows you a token on this screen — copy it
6. If you missed that screen, get the token from **My Account → Security → Generate Tokens** (type: User Token). Copy it immediately — shown only once
7. Get your project key from **Project Information** in the left sidebar
8. Add `SONAR_TOKEN` and `SONAR_HOST_URL` (`https://sonarcloud.io`) as GitHub Secrets
9. When SonarCloud asks how to define new code, choose **Number of days** (30 days) — this works correctly for continuous delivery workflows without version tags

Confirm `sonar-project.properties` at the repo root has the matching `projectKey` and `organization` values from steps 2 and 7.

---

# Running the Pipeline

**[Local Machine or EC2]**

```bash
# Push to develop to trigger the workflow
git checkout develop
git add .
git commit -m "feat: set up ESLint and sonar-project.properties"
git push origin develop
```

Watch the pipeline at: GitHub repo → Actions tab → CI/CD Pipeline.

Expected flow:
1. lint + npm-audit + gitleaks + hadolint (all parallel) — ~1-2 min
2. sonarqube + trivy-fs (parallel, after all four pass) — ~2-3 min
3. build-push (parallel: backend + frontend) — ~3-5 min
4. trivy-image + checkov (parallel, after build) — ~2-3 min
5. update-manifest — ~30s

After Job 10 completes, check the repo: `charts/usermgmt/values.yaml` should show the updated tag. This commit is what ArgoCD watches.

---

# Troubleshooting

**ESLint not found**
`npm run lint` fails with "eslint not found" — the lint script is missing from `package.json`, or `eslint` isn't in `devDependencies`. Verify both and run `npm install` locally first.

**npm audit fails**
A HIGH or CRITICAL CVE exists in a dependency. Run `npm audit fix` first to resolve what can be fixed safely.

If HIGH vulnerabilities remain in `client/` after running `npm audit fix`, they are likely buried inside `react-scripts` dependencies (`nth-check`, `serialize-javascript`, `webpack-dev-server`). The only fix npm offers is `npm audit fix --force`, which installs `react-scripts@0.0.0` — a breaking change that destroys the build. Do not run it.

These are build-tool vulnerabilities that do not reach the production bundle — `client/` compiles to static files, no Node process runs in prod. The accepted exception is to change the `client` matrix entry in the `npm-audit` job to use `--audit-level=critical` instead of `--audit-level=high`. This keeps the gate active for any CRITICAL findings while ignoring the unfixable react-scripts HIGHs. Document the exception in a comment in the workflow file.

**SonarCloud scan fails**
Check that `SONAR_TOKEN` is set correctly in GitHub Secrets and that `sonar-project.properties` exists at the repo root with the correct `sonar.organization` and `sonar.projectKey` values.

**update-manifest fails**
`GH_PAT` is missing or doesn't have `Contents: read/write` permission on the repo. Recreate the token with the correct scope and update the secret.

---

# Self-Check

Three signals confirm the pipeline is working end-to-end:

```bash
# Check the latest pipeline run status (requires GitHub CLI)
gh run list --limit 1
# Expected: completed  success  CI Pipeline  ...
# If it shows "failure", click the run URL to see which job failed
```

```bash
# Confirm the manifest update job wrote the new image tag
git pull
grep "tag:" charts/usermgmt/values.yaml
# Expected: tag: <short-sha>  (a 7-character git SHA, not "latest")
```

```bash
# Run security checks locally before your next push
cd api && npm audit --audit-level=high
# Expected: found 0 vulnerabilities
# Low/moderate findings are acceptable — high or critical need fixing
```

The `gh run list` output can include extra columns depending on your CLI version — what matters is that STATUS=completed and CONCLUSION=success appear on the same line. If the manifest tag still shows `latest`, the `update-manifest` job may have failed or the `GH_PAT` secret is missing write permission.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] `.github/workflows/ci-cd.yml` created
- [ ] `api/eslint.config.js` created
- [ ] `lint` script added to `api/package.json` and `client/package.json`
- [ ] `sonar-project.properties` added to repo root
- [ ] Local ESLint and npm audit pass before pushing
- [ ] All 5 secrets created in GitHub repo Settings
- [ ] Push to `develop` triggers the workflow
- [ ] All 10 jobs pass (green checkmarks in Actions tab)
- [ ] `charts/usermgmt/values.yaml` shows updated `tag:` after pipeline completes
- [ ] Commit message in Git log shows `[skip ci]` tag

# What You Learned

- How GitHub Actions workflows, jobs, and steps relate to each other
- How `needs:` controls job execution order and enables parallel gates
- How matrix strategy avoids duplicating job definitions
- The difference between ESLint (code quality) and `node --check` (parse-only)
- Why npm audit and Trivy FS cover different parts of the dependency risk surface
- Why `[skip ci]` is required in manifest-update commits
- Why a PAT is needed for the manifest push (vs the default GITHUB_TOKEN)

# Next

**Day 6:** ArgoCD GitOps — wire the repo to ArgoCD and run the full GitOps loop end-to-end.
