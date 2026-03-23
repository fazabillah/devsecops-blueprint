# Day 4: Helm Charts

**Branch:** `feature/k8s`

Raw `kubectl apply` works, but it doesn't scale. Helm adds templating, versioned releases, and a single command to install or upgrade the full app. It's the standard packaging format teams use in real deployments — knowing it is a baseline expectation in most DevOps JDs.

## What Helm Does

Helm is a package manager for Kubernetes. Instead of maintaining separate YAML files for every environment, you write templates once and inject values at install time. A `helm upgrade` replaces a `kubectl apply` for the whole app in one command, and `helm rollback` rolls it back.

Three core concepts:

- **Chart** — the package: templates + default values
- **Release** — a deployed instance of a chart (`helm install` creates one)
- **Values** — the configuration injected into templates at render time

---

# Chart Structure

> **[Local Machine]** — All chart files are created on your local machine inside the repo, then committed and pushed to Git. The EC2 VM only runs `helm install` after pulling the latest code.

```
charts/usermgmt/
├── Chart.yaml                  # Chart metadata (name, version, appVersion)
├── values.yaml                 # Default values — CI overrides image.tag on every build
└── templates/
    ├── _helpers.tpl            # Named template definitions (no output itself)
    ├── namespace.yaml
    ├── storageclass.yaml
    ├── mysql.yaml              # Secret, ConfigMaps, Service, StatefulSet
    ├── backend.yaml            # Deployment + Service
    ├── frontend.yaml           # Deployment + Service
    ├── ingress.yaml
    ├── clusterissuer.yaml
    └── networkpolicies.yaml    # 3 NetworkPolicy resources
```

The files in `templates/` are **not** copies or moves of the `k8s/` files. They are rewritten versions of the same Kubernetes resources, with hardcoded values replaced by `{{ .Values.* }}` Helm references. The `k8s/` directory stays in the repo untouched as a raw manifest reference — both can coexist.

---

# Key Files

> **[Local Machine]** — Create all files below inside `charts/usermgmt/` at the repo root.

### Chart.yaml

```yaml
apiVersion: v2
name: usermgmt
description: 3-tier user management app
version: 0.1.0
appVersion: "2.0.0"
```

`version` is the chart version. `appVersion` is the app version — informational only, doesn't affect the image tag used. The image tag comes from `values.yaml`.

### values.yaml

```yaml
namespace: prod
domain: learndevops.my

image:
  backend: fazabillah/backend
  frontend: fazabillah/frontend
  tag: latest  # CI overrides this with the short commit SHA on every run

replicaCount:
  backend: 3
  frontend: 3

mysql:
  password: ""  # Always passed via --set at deploy time, never committed

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

`mysql.password` is intentionally blank. Never put a real password in a committed file. Pass it at install time:

```bash
helm install usermgmt ./charts/usermgmt --set mysql.password=Faza123 -n prod --create-namespace
```

### Template Syntax

A template value reference looks like this:

```yaml
# In templates/backend.yaml
image: {{ .Values.image.backend }}:{{ .Values.image.tag }}
namespace: {{ .Values.namespace }}
replicas: {{ .Values.replicaCount.backend }}
```

For string values that Kubernetes expects quoted (CPU, memory), use the `quote` function:

```yaml
memory: {{ .Values.resources.backend.requests.memory | quote }}
```

---

# Template Files

> **[Local Machine]** — Create each file below inside `charts/usermgmt/templates/`. These replace the hardcoded values in `k8s/` with `{{ .Values.* }}` references.

### templates/_helpers.tpl

Named templates used across other template files. Defines a reusable app label block.

```
{{- define "usermgmt.labels" -}}
app: {{ .name }}
{{- end }}
```

### templates/namespace.yaml

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Values.namespace }}
```

### templates/storageclass.yaml

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-sc
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
parameters:
  type: gp3
```

### templates/mysql.yaml

```yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: mysql-secret
  namespace: {{ .Values.namespace }}
  labels:
    app: mysql
type: Opaque
stringData:
  MYSQL_ROOT_PASSWORD: {{ .Values.mysql.password | quote }}

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-config
  namespace: {{ .Values.namespace }}
  labels:
    app: mysql
data:
  MYSQL_DATABASE: crud_app

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-initdb-config
  namespace: {{ .Values.namespace }}
  labels:
    app: mysql
data:
  init.sql: |
    CREATE DATABASE IF NOT EXISTS crud_app;
    USE crud_app;
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role ENUM('admin', 'viewer') NOT NULL DEFAULT 'viewer',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

---
apiVersion: v1
kind: Service
metadata:
  name: mysql
  namespace: {{ .Values.namespace }}
  labels:
    app: mysql
spec:
  clusterIP: None
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
  namespace: {{ .Values.namespace }}
  labels:
    app: mysql
  annotations:
    checkov.io/skip1: "CKV_K8S_23=MySQL official image requires root for data directory init"
    checkov.io/skip2: "CKV_K8S_22=MySQL requires writable /var/run/mysqld socket file"
    checkov.io/skip3: "CKV_K8S_37=MySQL requires SETGID, SETUID, CHOWN, DAC_OVERRIDE, FOWNER capabilities for data directory initialization"
    checkov.io/skip4: "CKV_K8S_25=MySQL requires SETGID, SETUID, CHOWN, DAC_OVERRIDE, FOWNER capabilities for data directory initialization"
    checkov.io/skip5: "CKV_K8S_20=MySQL requires allowPrivilegeEscalation for setuid call during entrypoint initialization"
spec:
  serviceName: mysql
  replicas: 1
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      automountServiceAccountToken: false
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: mysql
          image: mysql:8
          imagePullPolicy: Always
          ports:
            - containerPort: 3306
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-secret
                  key: MYSQL_ROOT_PASSWORD
            - name: MYSQL_DATABASE
              valueFrom:
                configMapKeyRef:
                  name: mysql-config
                  key: MYSQL_DATABASE
          livenessProbe:
            exec:
              command: [mysqladmin, ping, -h, localhost]
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            exec:
              command: [mysqladmin, ping, -h, localhost]
            initialDelaySeconds: 10
            periodSeconds: 5
          resources:
            requests:
              cpu: {{ .Values.resources.mysql.requests.cpu | quote }}
              memory: {{ .Values.resources.mysql.requests.memory | quote }}
            limits:
              cpu: {{ .Values.resources.mysql.limits.cpu | quote }}
              memory: {{ .Values.resources.mysql.limits.memory | quote }}
          securityContext:
            allowPrivilegeEscalation: true
            capabilities:
              drop:
                - ALL
              add:
                - SETGID
                - SETUID
                - CHOWN
                - DAC_OVERRIDE
                - FOWNER
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
            - name: initdb
              mountPath: /docker-entrypoint-initdb.d
      volumes:
        - name: initdb
          configMap:
            name: mysql-initdb-config
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: ebs-sc
        resources:
          requests:
            storage: 5Gi
```

### templates/backend.yaml

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: {{ .Values.namespace }}
  labels:
    app: backend
spec:
  replicas: {{ .Values.replicaCount.backend }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: backend
          image: {{ .Values.image.backend }}:{{ .Values.image.tag }}
          ports:
            - containerPort: 5000
          env:
            - name: DB_HOST
              value: mysql
            - name: DB_USER
              value: root
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-secret
                  key: MYSQL_ROOT_PASSWORD
            - name: DB_NAME
              valueFrom:
                configMapKeyRef:
                  name: mysql-config
                  key: MYSQL_DATABASE
            - name: PORT
              value: "5000"
            - name: NODE_ENV
              value: production
            - name: JWT_SECRET
              value: devopsFazaSuperSecretKey
          livenessProbe:
            httpGet:
              path: /api/health
              port: 5000
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /api/health
              port: 5000
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: {{ .Values.resources.backend.requests.cpu | quote }}
              memory: {{ .Values.resources.backend.requests.memory | quote }}
            limits:
              cpu: {{ .Values.resources.backend.limits.cpu | quote }}
              memory: {{ .Values.resources.backend.limits.memory | quote }}
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 1000
            capabilities:
              drop: ["ALL"]

---
apiVersion: v1
kind: Service
metadata:
  name: backend-service
  namespace: {{ .Values.namespace }}
spec:
  selector:
    app: backend
  ports:
    - port: 5000
      targetPort: 5000
  type: ClusterIP
```

### templates/frontend.yaml

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: {{ .Values.namespace }}
  labels:
    app: frontend
spec:
  replicas: {{ .Values.replicaCount.frontend }}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: {{ .Values.image.frontend }}:{{ .Values.image.tag }}
          imagePullPolicy: Always
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: {{ .Values.resources.frontend.requests.cpu | quote }}
              memory: {{ .Values.resources.frontend.requests.memory | quote }}
            limits:
              cpu: {{ .Values.resources.frontend.limits.cpu | quote }}
              memory: {{ .Values.resources.frontend.limits.memory | quote }}
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            runAsUser: 101
            capabilities:
              drop: ["ALL"]

---
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: {{ .Values.namespace }}
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
```

### templates/ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  namespace: {{ .Values.namespace }}
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - {{ .Values.domain }}
      secretName: app-tls-cert
  rules:
    - host: {{ .Values.domain }}
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: backend-service
                port:
                  number: 5000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-service
                port:
                  number: 80
```

### templates/clusterissuer.yaml

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: {{ .Values.tls.email }}
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
```

### templates/networkpolicies.yaml

```yaml
---
# MySQL: only accepts traffic from backend pods on port 3306
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mysql-network-policy
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: mysql
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: backend
      ports:
        - protocol: TCP
          port: 3306

---
# Backend: only accepts traffic from frontend pods on port 5000
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-network-policy
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 5000

---
# Frontend: only accepts traffic from ingress-nginx namespace on port 80
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: frontend-network-policy
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      app: frontend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 80
```

---

# NetworkPolicies

The chart adds three NetworkPolicy resources in `templates/networkpolicies.yaml`.

Without NetworkPolicies, every pod can talk to every other pod in the cluster on any port. These policies enforce least-privilege:

- MySQL accepts traffic only from backend pods on port 3306
- Backend accepts traffic only from frontend pods on port 5000
- Frontend accepts traffic only from the ingress-nginx namespace on port 80

The ingress-nginx namespace needs a label for the namespaceSelector to match:

```bash
# Label the ingress-nginx namespace so the NetworkPolicy selector works
kubectl label namespace ingress-nginx kubernetes.io/metadata.name=ingress-nginx
```

This label is usually set automatically on Kubernetes 1.21+, but verify it:

```bash
kubectl get namespace ingress-nginx --show-labels
```

---

# Security Context

Backend and frontend containers run with:

```yaml
securityContext:
  allowPrivilegeEscalation: false
  runAsNonRoot: true
  runAsUser: 1000       # backend (Node.js)
  capabilities:
    drop: ["ALL"]
```

Frontend uses `runAsUser: 101` (the nginx user UID in the alpine image).

MySQL is different. Its entrypoint initializes the data directory as root and calls `setuid()` to drop to the `mysql` user before starting. Blocking this at the kernel level (`allowPrivilegeEscalation: false`) causes an immediate `CrashLoopBackOff` with `setuid: Operation not permitted`. The MySQL StatefulSet therefore requires:

```yaml
securityContext:
  allowPrivilegeEscalation: true
  capabilities:
    drop:
      - ALL
    add:
      - SETGID
      - SETUID
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
```

All five capabilities are required by the MySQL entrypoint script to set up the data directory on first boot. Checkov skips for these are annotated on the StatefulSet (skip1–skip5 above).

---

# Checkov Skip List

The chart has two categories of Checkov skips. The per-resource `checkov.io/skip` annotations on the StatefulSet handle MySQL-specific checks. Four additional checks apply to all K8s resources and belong in a repo-root `.checkov.yaml`:

```yaml
# .checkov.yaml (add these K8s entries alongside the AWS entries from Day 03)
skip-check:
  - CKV_K8S_43  # Image digest: incompatible with tag-based GitOps workflow
  - CKV_K8S_40  # High UID: nginx=101 and MySQL=root are image-level constraints
  - CKV_K8S_35  # Secrets as env vars: MySQL init requires env vars; app refactor out of scope
  - CKV_K8S_22  # ReadOnly filesystem: nginx/MySQL need writable paths (image constraints)
```

These checks fail not because of misconfiguration but because upstream images (nginx, MySQL) have constraints that cannot be fixed from outside the image. The justifications are documented inline.

---

# Local Validation

**[Local Machine]**

```bash
# Install Helm (macOS)
brew install helm

# Lint — catches syntax errors and missing required fields
helm lint ./charts/usermgmt

# Dry-run render — shows what YAML would be generated without applying it
helm template usermgmt ./charts/usermgmt \
  --set mysql.password=test123 \
  --namespace prod

# If you have a cluster, do a dry-run install
helm install usermgmt ./charts/usermgmt \
  --set mysql.password=test123 \
  --namespace prod \
  --create-namespace \
  --dry-run
```

Expected output from `helm lint`:
```
==> Linting ./charts/usermgmt
[INFO] Chart.yaml: icon is recommended
1 chart(s) linted, 0 chart(s) failed
```

---

# Install on EKS

> **Stop here. Do not run `helm install` yet.**
> This section runs during Day 06 (ArgoCD), not now. Move to Day 05 (GitHub Actions CI Pipeline) first. Come back here after Day 06 setup is complete and ArgoCD is wired.

**[EKS Installer VM]** — SSH into the EC2 VM, pull the latest code, then run helm install. The EC2 VM is used here because it has `kubectl` configured against the EKS cluster.

```bash
git pull

# Install the chart with the real password
helm install usermgmt ./charts/usermgmt \
  --set mysql.password=Faza123 \
  --namespace prod \
  --create-namespace

# Check pods
kubectl get pods -n prod

# Check the release
helm list -n prod
```

To upgrade after a values change:

```bash
helm upgrade usermgmt ./charts/usermgmt \
  --set mysql.password=Faza123 \
  --namespace prod
```

To roll back to the previous release:

```bash
helm rollback usermgmt 1 -n prod
```

`helm rollback` without a revision number rolls back to the previous release. Use `helm history usermgmt -n prod` to see all revisions and pick a specific one.

### When to Roll Back

New pods not starting after `helm upgrade`? Work through this before deciding:

```
kubectl get pods -n prod  →  CrashLoopBackOff or Pending?
  └─ Yes → kubectl describe pod <pod-name> -n prod  →  read the Events section
       ├─ Image pull error  →  check DockerHub tag exists, check imagePullPolicy
       ├─ OOMKilled         →  resource limits too low in values.yaml, adjust and upgrade again
       └─ Config error / app crash  →  roll back now, fix values, upgrade again
            └─ helm rollback usermgmt -n prod
```

Image pull errors and OOMKilled are fixable without a rollback — fix the values and run `helm upgrade` again. Config errors or application crashes warrant rolling back immediately, then fixing forward.

---

# Uninstall

```bash
# Remove all resources managed by this release
helm uninstall usermgmt -n prod
```

> **Note:** The StatefulSet PVC is not deleted by `helm uninstall`. Delete it manually if you want a clean slate:
> ```bash
> kubectl delete pvc mysql-data-mysql-0 -n prod
> ```

---

# Self-Check

Three signals confirm the chart is correct and deployed:

```bash
# Chart passes lint with no errors
helm lint charts/usermgmt --set mysql.password=test
# Expected: 1 chart(s) linted, 0 chart(s) failed
# Warnings are acceptable; failures are not
```

```bash
# Template renders all expected resource types
helm template usermgmt charts/usermgmt --set mysql.password=test | grep "^kind:"
# Expected: lines showing Namespace, StorageClass, Secret, ConfigMap,
#           StatefulSet, Deployment (appears twice), Service (appears three times),
#           Ingress, NetworkPolicy, and related resources
# Missing kinds mean a template file has a syntax error or wrong indentation
```

```bash
# Release is deployed and not in failed state
helm list -n prod
# Expected: usermgmt  prod  deployed  ...
# "failed" status means the last install or upgrade didn't complete — run
# helm rollback usermgmt -n prod to get back to the last good state
```

Lint catches YAML syntax errors. Template rendering catches logic errors (missing required values, broken conditionals). If lint passes but pods still fail after deploy, the issue is usually in values — check what `helm get values usermgmt -n prod` shows versus what the containers actually need.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] `helm lint ./charts/usermgmt` passes with 0 failures
- [ ] `helm template` renders all 10+ resource types without error
- [ ] `mysql.password` is not committed — always passed via `--set`
- [ ] `kubectl label namespace ingress-nginx kubernetes.io/metadata.name=ingress-nginx` run on cluster
- [ ] NetworkPolicies visible: `kubectl get networkpolicy -n prod`
- [ ] SecurityContext on backend and frontend pods: `kubectl describe pod <pod> -n prod | grep -A5 securityContext`

# What You Learned

- How Helm templating works: Chart, Release, Values
- How to write templates that reference `{{ .Values.* }}` fields
- How to pass secrets at install time with `--set` instead of committing them
- What NetworkPolicies enforce and how pod-label selectors work
- Why securityContext matters and which UIDs nginx and Node.js use

**Next: Day 05 — GitHub Actions CI Pipeline — automate build, push, and manifest update**
