# DevSecOps Blueprint: Overview

This series covers a complete end-to-end DevSecOps pipeline using a 3-tier application deployed to EKS with GitHub Actions CI, Helm packaging, and ArgoCD GitOps.

# Reading Order

| Day | File | Content |
|-----|------|---------|
| 00 | `00-introduction.md` | Architecture, tech stack, prerequisites |
| 01 | `01-local-run.md` | Run app locally on EC2 |
| 02 | `02-multi-stage-dockerfile.md` | Multi-stage Docker builds + docker-compose |
| 03 | `03-kubernetes-deployment.md` | EKS cluster + manual K8s deploy |
| 04 | `04-helm-charts.md` | Helm chart packaging |
| 05 | `05-github-actions-ci-pipeline.md` | GitHub Actions: full 10-job pipeline |
| 06 | `06-argocd-gitops.md` | ArgoCD GitOps, full loop end-to-end |
| 07 | `07-production-deployment.md` | Production infra: TLS, ingress, DNS |
| 08 | `08-monitoring-setup.md` | Prometheus + Grafana |

---

# What This Series Covers

| Area | Implementation |
|---|---|
| CI/CD | GitHub Actions (10-job pipeline) |
| Deployment method | Helm chart + ArgoCD GitOps sync |
| GitOps | ArgoCD with Automatic sync, Self Heal, Prune |
| Pipeline end state | DockerHub push + `values.yaml` tag commit |
| Network security | 3 NetworkPolicies (least-privilege pod traffic) |
| Container security | Non-root user, drop ALL capabilities |
| Health monitoring | Liveness + readiness probes on all pods |
| K8s manifests | Helm chart in `charts/usermgmt/` (templated) |
| JS linting | ESLint with `eslint:recommended` rules |
| Dependency scanning | npm audit (HIGH/CRITICAL CVEs in npm packages) |
| Dockerfile linting | Hadolint on both Dockerfiles |
| IaC scanning | Checkov on Helm chart + Terraform (`eks/`) |

The `k8s/` directory is kept intact as a raw manifest reference. The Helm chart is additive.

---

# Architecture

```
Developer
    │
    ├── git push → GitHub
    │
    ├── GitHub Actions CI (10 jobs)
    │       ├── ESLint + npm audit + GitLeaks + Hadolint (parallel)
    │       ├── SonarQube + Trivy FS (parallel, after above)
    │       ├── Docker build + push (backend, frontend)
    │       ├── Trivy image scan + Checkov IaC scan (parallel)
    │       └── Update charts/usermgmt/values.yaml (image tag)
    │
    └── ArgoCD (watches Git repo)
            ├── Detects values.yaml tag change → OutOfSync
            ├── Auto-sync: helm upgrade usermgmt
            └── New pods roll out in prod namespace
```

---

# Skill Map

| Skill | Why it matters |
|---|---|
| GitHub Actions | More common than Jenkins in most companies; matrix builds, secrets management |
| Helm | Standard in real teams — raw `kubectl apply` is dev-only |
| ArgoCD | Pull-based CD, drift detection, self-heal — increasingly required in entry-level JDs |
| Full GitOps loop | CI updates manifest → ArgoCD auto-deploys — shows you understand the complete automation chain |
| NetworkPolicies | Pod-to-pod traffic segmentation — security interviewers will ask how pods talk to each other |
| securityContext | Non-root containers, drop ALL capabilities — expected in any DevSecOps context |
| Liveness/readiness probes | Pod lifecycle, production reliability — shows you know the difference between running and ready |
| ESLint | Static analysis beyond syntax — code quality gates |
| npm audit | SCA — CVE scanning for npm packages; covers the advisory database Trivy doesn't always hit |
| Hadolint | Dockerfile best-practice enforcement — catches security issues before the image is built |
| Checkov | IaC misconfiguration scanning — standard tool in DevSecOps |

---

# Key Files

```
charts/usermgmt/                   Helm chart (templated from k8s/ manifests)
  Chart.yaml
  values.yaml
  templates/
    _helpers.tpl
    namespace.yaml
    storageclass.yaml
    mysql.yaml
    backend.yaml
    frontend.yaml
    ingress.yaml
    clusterissuer.yaml
    networkpolicies.yaml

.github/workflows/ci-cd.yml        GitHub Actions pipeline (10 jobs)

k8s/networkpolicies.yaml           Raw NetworkPolicy manifests (reference copy)
```

# Files the User Creates (documented in day-05 guide)

```
api/eslint.config.js        ESLint config for Node.js backend
sonar-project.properties    SonarCloud project config (repo root)
```
