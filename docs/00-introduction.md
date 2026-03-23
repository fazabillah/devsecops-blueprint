# Day 0: DevSecOps Project Introduction

**Repository:** https://github.com/fazabillah/devsecops-blueprint

# What This Guide Covers

Introduction to the complete DevSecOps mega project series and what you will build throughout the journey.

# Key Topics

### Roadmap
- Overview of all stages (Day 0 to Day 8)
- Tools and technologies covered
- Expected learning outcomes

### Architecture Introduction
- Frontend (React)
- Backend (Node.js/Express)
- Database (MySQL)
- How tiers communicate

# Technology Stack Reference

| Component | Version |
|-----------|---------|
| Backend runtime | Node.js 22 LTS (`node:22-alpine`) |
| Frontend build | Node.js 22 (`node:22-alpine`) |
| Frontend runtime | nginx:alpine |
| Database | MySQL 8 |
| Container registry | DockerHub |
| CI/CD | GitHub Actions |
| Container orchestration | Kubernetes (EKS) |
| Infrastructure as Code | Terraform |
| App packaging | Helm |
| GitOps / CD | ArgoCD |
| Security scanning | Trivy, GitLeaks, Checkov |
| Code quality | SonarCloud |
| Monitoring | Prometheus + Grafana (kube-prometheus-stack) |

### What Makes This "DevSecOps"
- Security integrated at every stage of the pipeline
- SAST — SonarCloud static analysis, ESLint, Checkov IaC scanning
- SCA — npm audit and Trivy filesystem scan for dependency CVEs
- Container scanning — Trivy image scan after build
- Secret scanning — GitLeaks on every push
- Note: DAST (dynamic application security testing) is not covered in this series

### Skills You'll Build
- Git branching strategies
- CI/CD pipelines
- Docker containerization
- Kubernetes orchestration
- Infrastructure as Code (Terraform)
- Security scanning tools
- Monitoring and observability

> **Note on logging:** Centralized logging (ELK stack) is excluded from this project. Running Elasticsearch alongside Prometheus on t2.medium nodes exhausts available RAM. Infrastructure metrics via Prometheus + Grafana cover what this project needs. `kubectl logs` and structured container stdout handle ad-hoc log access.

## Prerequisites

- Basic Linux knowledge
- Understanding of Git basics
- AWS account (free tier works)
- GitHub account
- Basic understanding of Docker concepts

# Getting Started

### 1. Fork the repository

```bash
# Go to GitHub
https://github.com/fazabillah/devsecops-blueprint

# Click Fork button
# Clone your forked repo
git clone https://github.com/fazabillah/devsecops-blueprint.git
cd devsecops-blueprint
```

### 2. Review the repository structure

```bash
# Explore folders
ls -la

# Key directories:
# client/ - Frontend React application
# api/ - Backend Node.js API
# database/ - MySQL schemas
# k8s/ - K8s manifests
```

### 3. Set up your learning environment

```bash
# Create a learning tracker
mkdir devsecops-learning
cd devsecops-learning
touch progress.md

# Document your journey
echo "# DevSecOps Learning Journey" >> progress.md
echo "## Day 0 - $(date)" >> progress.md
echo "- Forked repository" >> progress.md
```

### 4. Prepare AWS account

- Sign up for AWS free tier if you don't have account
- Configure billing alerts (stay within free tier)
- Verify email

### 5. Install essential tools locally

```bash
# Git (should already be installed)
git --version

# Node.js (for local testing in Day 1)
# Visit: https://nodejs.org/

# Docker Desktop
# Visit: https://www.docker.com/products/docker-desktop

# VS Code or your preferred IDE
```

# What to Expect

This is a production-grade project built the way companies actually build things — security checks baked into the pipeline, not bolted on at the end. You'll build the complete pipeline from scratch, day by day, following real corporate workflows. The focus is hands-on: every tool you configure, every scan that runs, every deployment that ships is something you wired up yourself.

Kubernetes is not a prerequisite. You'll learn it as part of the project, in context, when it matters.

# Common Questions

**Q: Do I need to know Kubernetes before starting?**
A: No, you'll learn Kubernetes as part of the project.

**Q: Will this cost money on AWS?**
A: Mostly free tier, but you may incur small costs ($5-10) if you leave resources running. Always shut down when not practicing.

**Q: How long does the full project take?**
A: If following along daily, about 8-10 days. At your own pace, 2-3 weeks is realistic.

**Q: What if I get stuck?**
A: The repo has documentation, GitHub Issues has community help, and error messages are usually specific enough to troubleshoot directly.

# Self-Check

Verify your tools are installed before moving on. Run each command and confirm the version prints without error:

```bash
git --version          # git version 2.x.x
node --version         # v22.x.x
docker --version       # Docker version 2x.x.x
docker compose version # Docker Compose version v2.x.x
```

No output comparison needed here — any version printing means the tool is present. If a command returns "command not found", go back to the installation step for that tool.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Preparation Checklist

Before moving to Day 1:

- [ ] Forked GitHub repository
- [ ] Cloned repository locally
- [ ] Have AWS account ready
- [ ] Have GitHub account ready
- [ ] Basic tools installed (Git, Node, Docker)
- [ ] Understand the 3-tier architecture concept
- [ ] Know what days 1-8 will cover
- [ ] Ready to commit time for hands-on practice

# Next

**Day 1:** 3-Tier Project Local Run — you'll run the complete application on your local machine to understand how it works before deploying to cloud.

# Mental Model to Build

```
Developer → Git → CI Pipeline → Security Scans → Build → Push → Deploy → Monitor
```

You'll implement every single step of this flow by the end of the series.



