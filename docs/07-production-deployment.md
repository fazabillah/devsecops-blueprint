# Day 7: Production Deployment

**Branch:** `main`

**INFO:**
External IP `ab7ccead4b22a41288c198a3453d3665-467151969.us-east-1.elb.amazonaws.com`

## What You'll Learn

Production deployment with TLS, cert-manager, DNS setup, and production-grade Kubernetes manifests.

## Key Concepts

### Continuous Delivery vs Continuous Deployment

**Continuous Delivery:**
- Code automatically deployed to staging
- Manual approval required for production
- Human verification before production release

**Continuous Deployment:**
- Code automatically deployed to production
- No manual intervention
- Every passing build goes to production

This project uses **Continuous Delivery** for production safety. The approval gate is ArgoCD's sync policy — Automatic sync with Self Heal means every merged manifest change deploys automatically, but a human still controls what gets merged.

# Part 1: EKS Cluster

> If your cluster from Day 03 is still running, skip to Part 2.

If you ran `terraform destroy` after Day 03:

```bash
cd eks
terraform apply
aws eks update-kubeconfig --region us-east-1 --name devopsfaza-cluster
kubectl get nodes
```

# Part 2: Fix CoreDNS for Non-Standard TLDs

> If you followed Day 03 and already applied this fix, verify it's still in place before continuing. Run the `nslookup` test below — if it returns IPs, skip to Part 3.

AWS VPC DNS resolver fails on some TLDs including `.my`. cert-manager does a self-check by resolving your domain from inside the cluster before submitting to Let's Encrypt — if CoreDNS can't resolve it, TLS issuance stalls silently with no obvious error.

Fix CoreDNS to use public resolvers:

```bash
kubectl edit configmap coredns -n kube-system
# Find the line:  forward . /etc/resolv.conf
# Change it to:   forward . 8.8.8.8 1.1.1.1

kubectl rollout restart deployment/coredns -n kube-system

# Verify domain resolves from inside the cluster
kubectl run dns-test --image=busybox --restart=Never --rm -it -- nslookup learndevops.my
# Must return IPs before continuing
```

Do not proceed to cert-manager until this test passes.

# Part 3: DNS Setup with Route 53

> Verify first — if your domain already resolves, DNS is done. Skip to Part 4.

```bash
nslookup learndevops.my 8.8.8.8
# If this returns IPs, DNS is configured — skip to Part 4
```

Route 53 is the right choice here over Cloudflare. Route 53 hosted zones are natively resolvable by the AWS VPC DNS resolver, which means CoreDNS can resolve the domain even without the 8.8.8.8 override above. It also avoids `.my` TLD compatibility issues that some third-party resolvers have.

**[AWS Console]**

1. Route 53 → Hosted zones → Create hosted zone
2. Domain name: `learndevops.my` → Public hosted zone → Create
3. Route 53 creates 4 NS records — copy all four values
4. Yeahhost (or your registrar) → Nameservers → Use custom nameservers → paste the Route 53 NS values
5. Wait for NS propagation:
   ```bash
   nslookup -type=NS learndevops.my 8.8.8.8
   # Should return the Route 53 NS records
   ```
6. Get the ELB hostname:
   ```bash
   kubectl get svc -n ingress-nginx ingress-nginx-controller
   # Copy the EXTERNAL-IP value — it will be an AWS ELB DNS name
   ```
7. In Route 53, add an Alias record:
   - Name: `learndevops.my`, Type: A, Alias: Yes
   - Route traffic to: Application and Classic Load Balancer
   - Region: us-east-1
   - Load balancer: select the ELB DNS name from the dropdown (or paste it)
8. Verify:
   ```bash
   nslookup learndevops.my 8.8.8.8
   # Should return IPs — AWS resolves the alias automatically
   ```

> Use an Alias record rather than a plain A record pointing to ELB IPs. ELB IPs change when the cluster is rebuilt. An Alias record points to the ELB DNS name and AWS keeps the IP mapping current automatically — no manual update needed after a rebuild.

# Part 4: Install cert-manager for TLS

> Verify first — cert-manager is installed as a prerequisite before Day 06 (ArgoCD uses it for the Helm release). Check whether it's already running:

```bash
kubectl get pods -n cert-manager
# If cert-manager, cert-manager-cainjector, and cert-manager-webhook are all Running — skip to Part 5
```

If the namespace doesn't exist, install it now:

```bash
# Add the Jetstack Helm repo
helm repo add jetstack https://charts.jetstack.io
helm repo update

# Install cert-manager with CRDs
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

# Verify cert-manager pods are running
kubectl get pods -n cert-manager
```

> If you have completed Days 4, 5, and 6, continue to Part 5. cert-manager and the ClusterIssuer are already deployed as part of the Helm chart managed by ArgoCD.

# Part 5: Set Production API Base URL

Before building Docker images, verify `client/src/axios.js` has the correct production domain as the default:

```js
baseURL: process.env.REACT_APP_API || 'https://learndevops.my',
```

`REACT_APP_*` variables are baked into the React bundle at build time. Kubernetes environment variables cannot override them at runtime. If the default is `http://localhost:5000` (the dev default), every API call from the browser will go to localhost — login and registration will fail silently with a CORS error.

> Replace `learndevops.my` with your actual domain before the first pipeline run.

# Part 6: Production Kubernetes Manifests

**The production manifests are the Helm chart at `charts/usermgmt/`, not the raw files in `k8s/`.** ArgoCD deploys the chart via `helm upgrade` whenever `values.yaml` changes — no manual `kubectl apply` needed for ongoing deployments.

The raw `k8s/` manifests were created in Day 03 for manual testing only. They are reference files, not the live production configuration.

### What the Helm chart deploys

Every resource in `charts/usermgmt/templates/` is managed by ArgoCD:

| Template | What it creates |
|----------|----------------|
| `backend.yaml` | Deployment (3 replicas), ClusterIP Service, security hardening, resource limits, liveness/readiness probes |
| `frontend.yaml` | Deployment (3 replicas), ClusterIP Service, `imagePullPolicy: Always` |
| `mysql.yaml` | StatefulSet, headless Service, Secret, ConfigMaps, 5Gi EBS PVC |
| `ingress.yaml` | Ingress with TLS annotation (`cert-manager.io/cluster-issuer: letsencrypt-prod`) and `learndevops.my` host |
| `clusterissuer.yaml` | Let's Encrypt ClusterIssuer (`letsencrypt-prod`) |
| `networkpolicies.yaml` | Three NetworkPolicies scoping traffic between mysql ↔ backend ↔ frontend ↔ ingress |
| `storageclass.yaml` | EBS gp3 StorageClass (`ebs-sc`) |
| `namespace.yaml` | `prod` namespace |

### Configuring production values

Production configuration lives in `charts/usermgmt/values.yaml`:

```yaml
namespace: prod
domain: learndevops.my

replicaCount:
  backend: 3
  frontend: 3

tls:
  email: fazabillah@gmail.com

resources:
  backend:
    requests: { cpu: 250m, memory: 256Mi }
    limits:   { cpu: 500m, memory: 512Mi }
  frontend:
    requests: { cpu: 100m, memory: 128Mi }
    limits:   { cpu: 200m, memory: 256Mi }
  mysql:
    requests: { cpu: 500m, memory: 1Gi }
    limits:   { cpu: 1000m, memory: 2Gi }
```

To change any production setting — domain, replicas, resource limits — edit `values.yaml`, push to `develop`, and ArgoCD syncs the change automatically.

> **Known limitation:** The K8s Secret manifest uses `stringData`, which means the value is base64-encoded in etcd but not encrypted at rest. `JWT_SECRET` is set as a plain env var in the Deployment spec. Both are visible to anyone with cluster access. For production, replace these with External Secrets Operator pulling values from AWS Secrets Manager, or use Sealed Secrets for GitOps-safe secret storage.

# Part 7: CD via ArgoCD

CD to the cluster is handled by ArgoCD in Day 06. When the GitHub Actions pipeline in Day 05 completes, Job 10 commits an updated image tag to `charts/usermgmt/values.yaml`. ArgoCD detects this change and performs a `helm upgrade` automatically. No manual `kubectl apply` is needed for ongoing deployments.

To apply the bootstrap resources manually (initial setup or cluster rebuild only):

```bash
kubectl create namespace prod
kubectl apply -f k8s/sc.yaml
```

Everything else — backend, frontend, mysql, ingress, ClusterIssuer, NetworkPolicies — is deployed and managed by ArgoCD via the Helm chart.

> **Note on cluster endpoint:** When connecting kubectl to EKS, run `kubectl cluster-info` on the EKS Installer VM to get your cluster's API server endpoint. Every cluster has a unique endpoint — never copy one from a guide or another person's setup.

# Part 8: RBAC — Scoped CI/CD Access

> **Skipped for this project.** The pipeline works with the existing `k8-token` and nothing is broken. RBAC scoping is a security hardening step — it narrows the blast radius if the token leaks by restricting it to only what the pipeline needs (update deployments, read pods/services in `prod`). For a portfolio project this is out of scope, but the implementation is documented below for reference.

The default `k8-token` approach (storing a ServiceAccount token in GitHub Actions) works, but the token is typically bound to a ServiceAccount with broad cluster permissions. If that token leaks, an attacker can do far more than deploy your app.

RBAC fixes this. You create a dedicated ServiceAccount for CI/CD, bind it to a Role that allows only what the pipeline needs, and replace your broad `k8-token` with a token scoped to that Role.

### What the Role allows

The pipeline needs to:
- Roll out new Deployments (`kubectl set image`, `helm upgrade`)
- Read Pod status to verify rollout success
- Read Services for health checks

It does **not** need to read Secrets, delete namespaces, or touch other workloads.

### 1. Create `k8s/rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: deployer
  namespace: prod
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployment-manager
  namespace: prod
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: deployer-binding
  namespace: prod
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: deployment-manager
subjects:
- kind: ServiceAccount
  name: deployer
  namespace: prod
```

### 2. Apply it

```bash
kubectl apply -f k8s/rbac.yaml

# Verify the ServiceAccount exists
kubectl get serviceaccount deployer -n prod

# Verify the RoleBinding is in place
kubectl get rolebinding deployer-binding -n prod
```

### 3. Generate a token for the ServiceAccount

```bash
# Create a long-lived token (stored as a Secret)
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: deployer-token
  namespace: prod
  annotations:
    kubernetes.io/service-account.name: deployer
type: kubernetes.io/service-account-token
EOF

# Wait a moment, then extract the token
kubectl get secret deployer-token -n prod -o jsonpath='{.data.token}' | base64 --decode
```

Copy the decoded token value.

### 4. Replace the broad k8-token in GitHub Actions

Go to your GitHub repository → Settings → Secrets and variables → Actions.

Find the secret named `k8-token` (or whatever you named your cluster token) and update its value with the token you just decoded.

From this point, every pipeline run uses a token that can only manage Deployments, ReplicaSets, Pods, and Services in the `prod` namespace — nothing else.

### 5. Verify the restriction works

```bash
# This should succeed (allowed by the Role)
kubectl auth can-i update deployments --namespace prod --as system:serviceaccount:prod:deployer

# This should be denied (not in the Role)
kubectl auth can-i delete secrets --namespace prod --as system:serviceaccount:prod:deployer
kubectl auth can-i get secrets --namespace prod --as system:serviceaccount:prod:deployer
```

Both denial checks confirm the least-privilege boundary is working.

# Self-Check

Four signals confirm HTTPS, TLS, and RBAC are all working:

```bash
# App responds over HTTPS
curl -I https://learndevops.my
# Expected: HTTP/2 200 (or 301 redirect to HTTPS from HTTP)
# Connection refused means the Ingress or DNS isn't pointing at the ELB yet
```

```bash
# TLS certificate issued and ready
kubectl get certificate -n prod
# Expected: app-tls-cert  True  (READY column = True)
# If READY=False, cert-manager is still requesting the certificate — paste
# kubectl describe certificate app-tls-cert -n prod for diagnosis
```

```bash
# RBAC: deployer CAN update deployments
kubectl auth can-i update deployments --namespace prod \
  --as system:serviceaccount:prod:deployer
# Expected: yes
```

```bash
# RBAC: deployer CANNOT read secrets
kubectl auth can-i get secrets --namespace prod \
  --as system:serviceaccount:prod:deployer
# Expected: no
```

If the RBAC checks return the opposite of expected ("no" for the allowed action, "yes" for the denied one), the ClusterRole or RoleBinding wasn't applied correctly. Certificate issues often show meaningful error messages in `kubectl describe` — they're worth reading before assuming a DNS problem.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] Production EKS cluster created
- [ ] `client/src/axios.js` default baseURL set to production domain (not localhost)
- [ ] CoreDNS updated to use public resolvers (8.8.8.8 1.1.1.1)
- [ ] Route 53 hosted zone created for domain
- [ ] Registrar nameservers updated to Route 53 NS values
- [ ] Alias record in Route 53 pointing to ELB DNS name
- [ ] Domain resolves from inside the cluster (`nslookup` test passes)
- [ ] cert-manager installed via Helm (or verified already running)
- [ ] Helm chart (`charts/usermgmt/`) includes ClusterIssuer, TLS ingress, NetworkPolicies, resource limits
- [ ] `charts/usermgmt/values.yaml` has correct domain and TLS email
- [ ] ArgoCD deployed the Helm chart — all pods Running in `prod`
- [ ] TLS certificate issued by cert-manager (`kubectl get certificate -n prod` → READY=True)
- [ ] Application accessible via HTTPS (`curl -I https://learndevops.my` → HTTP/2 200)
- [ ] (Optional) `k8s/rbac.yaml` created and applied (ServiceAccount, Role, RoleBinding)
- [ ] (Optional) `deployer-token` Secret created and GitHub Actions `k8-token` replaced with scoped token
- [ ] (Optional) `kubectl auth can-i` checks confirm least-privilege boundary

# What You Learned

- Continuous Delivery vs Continuous Deployment
- Production-grade Kubernetes configuration via Helm chart
- Resource requests and limits
- Zero-downtime rolling updates
- RBAC: scoping CI/CD credentials to least privilege
- cert-manager and Let's Encrypt integration
- GitOps: production config changes flow through Git, not manual kubectl

# Next

**Day 8:** Monitoring Setup — Prometheus and Grafana for observability.

# Notes

- Always require manual approval or controlled sync policy for production
- Use different resource limits for environments
- Test in dev/staging before production
- Document approval process
- Monitor production deployments closely
