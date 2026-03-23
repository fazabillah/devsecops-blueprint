# Day 6: ArgoCD + GitOps

**Branch:** `feature/gitops`

All commands in this guide run on the **[EKS Installer VM]** — the same machine used throughout Day 03. If you're unsure which machine that is, see `docs/03-kubernetes-deployment.md` Part 0.

The pipeline in Day 05 ends by committing a new image tag to `charts/usermgmt/values.yaml`. ArgoCD picks that up and deploys it — without anyone running `kubectl apply`. That's the GitOps loop: Git is the source of truth, and the cluster converges to match it automatically.

This guide covers installing ArgoCD, wiring it to the repo, and running the full loop end-to-end on EKS.

---

## What GitOps Means in Practice

Push-based CD (running `kubectl apply` from a pipeline) works, but it has problems:
- The pipeline agent needs cluster credentials
- Drift isn't detected — if someone edits a deployment manually, the pipeline doesn't know
- Rollback means re-running the pipeline with an old tag

ArgoCD inverts this. It runs inside the cluster and pulls from Git. It compares the live cluster state against the Git state on a schedule. When they differ (OutOfSync), it reconciles. `Self Heal` reverts manual changes automatically. `Prune` removes resources deleted from Git.

---

# Infrastructure Session: Full Sequence

Do this in one continuous session. Stopping halfway leaves resources running and costing money.

### Step 1: Verify EKS is Running

**[EKS Installer VM]**

Your cluster was provisioned in Day 03. Verify it's still up:

```bash
aws eks update-kubeconfig --region us-east-1 --name devopsfaza-cluster
kubectl get nodes
# Expected: nodes in Ready state
```

If nodes are not showing (you destroyed the cluster since Day 03), reprovision using `docs/03-kubernetes-deployment.md` Part 1 before continuing.

### Step 2: Verify NGINX Ingress Controller

NGINX ingress was installed in Day 03 Part 1.5. Verify it's present:

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
# Expected: EXTERNAL-IP populated (LoadBalancer address)
```

If the service is missing, refer to `docs/03-kubernetes-deployment.md` Part 1.5 to reinstall.

### Step 3: Verify cert-manager

cert-manager was installed in Day 07 Part 4 (which runs before this guide per Day 07's sequencing instruction). Verify it's running:

```bash
kubectl get pods -n cert-manager
# Expected: cert-manager, cert-manager-cainjector, cert-manager-webhook pods in Running state
```

If the namespace doesn't exist, refer to `docs/07-production-deployment.md` Part 4 to install cert-manager before continuing.

### Step 4: Deploy App with Helm

Day 03 deployed the app using raw `kubectl apply` against the manifests in `k8s/`. This step switches to Helm, which is what ArgoCD will manage going forward. If those raw manifests are still deployed in the `prod` namespace, remove them first to avoid conflicts:

```bash
# Check if raw kubectl resources are still up
kubectl get deploy -n prod
```

If deployments exist from Day 03, remove them before installing via Helm:

```bash
kubectl delete -f k8s/backend.yaml -f k8s/frontend.yaml -f k8s/ingress.yaml -n prod
# Leave the MySQL StatefulSet PVC intact — Helm will manage it from here
```

Then install via Helm:

```bash
# Label ingress-nginx namespace for NetworkPolicy selector
kubectl label namespace ingress-nginx kubernetes.io/metadata.name=ingress-nginx

# Install the usermgmt chart — pass password at runtime, never commit it
helm install usermgmt ./charts/usermgmt \
  --set mysql.password=Faza123 \
  --namespace prod \
  --create-namespace
```

```bash
# Watch pods come up
kubectl get pods -n prod -w

# Check the certificate (cert-manager issues TLS via Let's Encrypt)
kubectl get certificate -n prod
# READY should be True within 2-3 minutes
```

```bash
# Check NetworkPolicies are in place
kubectl get networkpolicy -n prod
# Expected: mysql-allow-backend, backend-allow-frontend, frontend-allow-ingress
```

> **Note:** Update your DNS A record to point `learndevops.my` at the LoadBalancer IP from Step 2 before the certificate can be issued. Let's Encrypt performs an HTTP-01 challenge against that domain.

### Step 5: Install ArgoCD

```bash
kubectl create namespace argocd

kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
```

```bash
# Expose ArgoCD as a LoadBalancer so you can reach the UI
kubectl patch svc argocd-server -n argocd \
  -p '{"spec":{"type":"LoadBalancer"}}'
```

```bash
# Get the external IP (takes 1-2 min)
kubectl get svc argocd-server -n argocd -w
```

```bash
# Get the initial admin password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo
```

password: `ypI-rSDTozd8VRJd`

### Step 6: Configure ArgoCD Application

Open the ArgoCD UI at `http://<ARGOCD-EXTERNAL-IP>`. Log in with `admin` and the password from above.

**[ArgoCD UI]**

1. Click **New App**
2. Fill in the form:

| Field | Value |
|---|---|
| Application Name | `usermgmt` |
| Project | `default` |
| Sync Policy | Automatic |
| Self Heal | Enabled |
| Prune | Enabled |
| Repository URL | `https://github.com/fazabillah/devsecops-blueprint` |
| Revision | `develop` |
| Path | `charts/usermgmt` |
| Cluster URL | `https://kubernetes.default.svc` |
| Namespace | `prod` |
| Helm Values | `values.yaml` |
| Extra parameters | `mysql.password=Faza123` |

3. Click **Create**

ArgoCD will sync immediately, deploying from the current chart state. The Application card should show **Synced** and **Healthy** within a few minutes.

> **Known limitation:** The `mysql.password` value passed as an ArgoCD extra parameter is stored in the ArgoCD Application object and visible in the UI to anyone with ArgoCD access. ArgoCD does not pull from external secret stores by default. For production, remove the extra parameter and use External Secrets Operator (pulling from AWS Secrets Manager) or Sealed Secrets to keep the password out of the UI and out of Git.

### Step 7: Test the Full GitOps Loop

**[EKS Installer VM]**

```bash
# Make a trivial code change (e.g., update a comment in api/)
git checkout develop
echo "// v2 test" >> api/index.js
git add api/index.js
git commit -m "test: trigger CI/CD loop"
git push origin develop
```

Watch what happens:

1. **GitHub Actions triggers** — all 10 jobs run
2. **Job 10 completes** — `values.yaml` `tag:` field updated with new short SHA, committed with `[skip ci]`
3. **ArgoCD detects OutOfSync** — the tag in Git no longer matches what's deployed
4. **ArgoCD auto-syncs** — runs `helm upgrade`, new pods roll out
5. **Application returns to Synced + Healthy**

```bash
# Watch pods roll over
kubectl get pods -n prod -w
```

In the ArgoCD UI, the Application history tab will show the new sync event with the updated image tag.

### Rolling Back in ArgoCD

ArgoCD auto-syncs on every Git change. If a new image tag is broken, ArgoCD will keep trying to sync it and failing. A `helm rollback` alone won't hold — ArgoCD will overwrite it on the next sync.

The correct sequence:

1. **Disable auto-sync** in ArgoCD UI — App → App Details → Sync Policy → Disable Auto-Sync. This stops ArgoCD from fighting the rollback.
2. **Roll back the cluster** — `helm rollback usermgmt -n prod`
3. **Revert the bad commit in Git** — `git revert <sha>`, push to `develop`. This re-aligns Git with the cluster state.
4. **Re-enable auto-sync** in ArgoCD.

Git is the source of truth. A rollback that fixes the cluster but not Git will get overwritten the next time ArgoCD syncs.

### Step 8: Monitoring

Monitoring (Prometheus + Grafana) is covered in Day 08. Skip this step for now and continue to the verification section below.

---

# Verify Everything

```bash
# All app pods running
kubectl get pods -n prod

# TLS certificate issued
kubectl get certificate -n prod
# READY=True

# NetworkPolicies in place
kubectl get networkpolicy -n prod
# 3 policies

# ArgoCD application state
kubectl get application -n argocd
# SYNC STATUS: Synced, HEALTH STATUS: Healthy

# App accessible
curl -I https://learndevops.my
# HTTP/2 200
```

---

# Cleanup

When done, run full cleanup per `my-guide/cleanup-guide.md`. The key steps:

```bash
# Uninstall Helm releases first (removes K8s resources)
helm uninstall usermgmt -n prod
helm uninstall cert-manager -n cert-manager
helm uninstall ingress-nginx -n ingress-nginx

# Delete ArgoCD
kubectl delete namespace argocd

# Destroy AWS infrastructure
cd eks
terraform destroy -auto-approve
```

> **Warning:** Verify `terraform destroy` completes cleanly. EBS volumes and Load Balancers created by Kubernetes can survive a `terraform destroy` if they aren't deleted first. Check the AWS Console for leftover resources after the destroy completes.

---

# Self-Check

Two signals — static status check, then a live end-to-end loop test:

```bash
# ArgoCD Application is Synced and Healthy
kubectl get application usermgmt -n argocd
# Expected: STATUS=Synced  HEALTH=Healthy
# "OutOfSync" means ArgoCD sees a diff between the cluster and Git — click the app
# in the ArgoCD UI to see which resource is drifting
```

For the end-to-end loop: make a small change to the `develop` branch (e.g., update a label in `values.yaml`), push it, then wait ~2 minutes for GHA to run and ArgoCD to sync. Then verify the new image tag rolled out:

```bash
kubectl get pods -n prod -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
# Expected: backend pods show an image tag matching the SHA from the latest GHA run
# If pods still show the old tag, check whether ArgoCD's sync completed and whether
# the GHA update-manifest job wrote the new SHA to charts/usermgmt/values.yaml
```

The loop test is the authoritative check — it confirms Git is the source of truth for what's running in the cluster. A static Synced/Healthy status without a live test only confirms that the last sync worked.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] `kubectl get nodes` shows nodes Ready (cluster running from Day 03)
- [ ] `kubectl get pods -n prod` — all Running
- [ ] `kubectl get certificate -n prod` — READY=True
- [ ] `kubectl get networkpolicy -n prod` — 3 policies listed
- [ ] ArgoCD UI: Application shows Synced + Healthy
- [ ] Push to `develop` → GHA pipeline green → `values.yaml` tag updated → ArgoCD syncs → new pods
- [ ] App accessible at https://learndevops.my
- [ ] `terraform destroy` completes, AWS Console confirms no leftover resources

# What You Learned

- How ArgoCD's pull-based model differs from push-based CD
- How to configure an ArgoCD Application pointing at a Helm chart in Git
- What Automatic sync, Self Heal, and Prune each do
- How the full GitOps loop works: code push → CI → manifest update → ArgoCD sync
- How to verify the loop end-to-end with `kubectl get pods -w`

**Next: Day 07 — Production Deployment — TLS, cert-manager, DNS, and RBAC.**
