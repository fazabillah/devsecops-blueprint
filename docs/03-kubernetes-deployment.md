# Day 3: EKS Cluster Setup and Manual Kubernetes Deployment

**Branch:** `feature/k8s`

## What You'll Learn

Provision an EKS cluster with Terraform and manually deploy the application to the `prod` namespace to verify the manifests work before ArgoCD automates it in Day 06.

## Prerequisites

- DockerHub images from Day 2
- An AWS account with permissions to create EC2, EKS, IAM, and VPC resources
- Tool installation is covered in Part 0

# Part 0: Set Up the EKS Installer VM

Every step labelled `[EKS Installer VM]` in this guide runs on a dedicated Ubuntu EC2 instance — not your local machine. This section explains what it is and how to provision it.

## What is the EKS Installer VM?

It's an EC2 instance that acts as the operations host for all Terraform and kubectl commands in this blueprint. Think of it as the control plane for your control plane work: Terraform state lives here, kubeconfig lives here, and every cluster operation runs from here.

## Why EC2 instead of your local machine?

A local machine works for a one-off experiment. The problem is that Terraform state is tied to wherever you ran `terraform apply`. Lose the laptop, reimage it, or switch to a different machine — now the state file is gone or out of sync, and Terraform no longer knows what it created. Recovering from that is painful.

An EC2 host in the same AWS account sidesteps this. You can assign an IAM role to the instance directly (no long-lived credentials stored in `~/.aws`), the state file stays close to the infrastructure it describes, and the setup mirrors how teams actually run Terraform — on a dedicated CI runner or ops VM, not a developer's laptop. For this blueprint, EC2 is the primary path for that reason. A local machine works if you only want to experiment and don't mind the tradeoff.

## Provision the VM

1. In the AWS Console, launch a `t3.small` instance using the **Ubuntu 22.04** AMI in `us-east-1`.
2. Create or reuse a key pair for SSH access.
3. Attach an IAM role with these AWS managed policies:
   - `AmazonEC2FullAccess`
   - `IAMFullAccess`
   - `AmazonVPCFullAccess`

   Then add an inline policy to the same role granting EKS permissions (the managed policies above do not include `eks:*`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "eks:*",
         "Resource": "*"
       }
     ]
   }
   ```

   > `AmazonEKSClusterPolicy` is meant for the EKS cluster's own IAM role (the one passed to `aws_eks_cluster`), not the installer VM. Attaching it to the VM grants no `eks:*` permissions and causes `terraform apply` to fail with AccessDeniedException.

4. In the instance's security group, allow inbound TCP on port 22 — restrict the source to your IP.
5. Once running, SSH in and install the required tools:

```bash
# Update package index
sudo apt update

# Git
sudo apt install -y git

# Terraform
sudo apt install -y gnupg software-properties-common
wget -O- https://apt.releases.hashicorp.com/gpg | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install -y terraform

# kubectl
curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install
```

The IAM role attached in step 3 means `aws` commands authenticate automatically — no `aws configure` needed.

> Assign an Elastic IP to this instance (see step 5.5 later in the guide) so the IP doesn't change when you stop and restart it between sessions.

---

# Part 1: Create EKS Cluster with Terraform

### 1a. Clone the EKS Terraform template

**[EKS Installer VM]**

The `eks/` directory is not committed to this repo. Clone it from the template:

```bash
# From the project root on the EKS Installer VM
git clone https://github.com/fazabillah/terraform-aws-eks-template.git eks
cd eks
```

This creates a local `eks/` directory containing `main.tf`, `variable.tf`, and `output.tf`. Those files provision the EKS cluster, node group, IAM roles, OIDC provider, and EBS CSI addon.

### 1b. Review Terraform Files

**[EKS Installer VM]**

```bash
# Check files
ls -la

# Key files:
# main.tf     - EKS cluster, node group, IAM roles, OIDC provider, EBS CSI addon
# variable.tf - Input variables (ssh_key_name)
# output.tf   - Outputs: cluster_id, node_group_id, vpc_id, subnet_ids
```

### 1c. Terraform file reference

The template as cloned is missing the OIDC + IRSA wiring the EBS CSI driver needs. Without it, the addon deploys and reports healthy, but the CSI controller pod cannot call AWS APIs — PVCs stay `Pending` indefinitely. The cluster security group also has no ingress rule on port 443 from the node SG, which breaks `kubectl exec`, admission webhooks, and metrics. The corrected file below includes both fixes. If you fork or modify the template repo, this is the target state.

```hcl
provider "aws" {
  region = "us-east-1"
}

# ── Networking ────────────────────────────────────────────────────────────────

resource "aws_vpc" "devopsfaza_vpc" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "devopsfaza-vpc" }
}

resource "aws_subnet" "devopsfaza_subnet" {
  count                   = 2
  vpc_id                  = aws_vpc.devopsfaza_vpc.id
  cidr_block              = cidrsubnet(aws_vpc.devopsfaza_vpc.cidr_block, 8, count.index)
  availability_zone       = element(["us-east-1a", "us-east-1b"], count.index)
  map_public_ip_on_launch = true
  tags = { Name = "devopsfaza-subnet-${count.index}" }
}

resource "aws_internet_gateway" "devopsfaza_igw" {
  vpc_id = aws_vpc.devopsfaza_vpc.id
  tags   = { Name = "devopsfaza-igw" }
}

resource "aws_route_table" "devopsfaza_route_table" {
  vpc_id = aws_vpc.devopsfaza_vpc.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.devopsfaza_igw.id
  }
  tags = { Name = "devopsfaza-route-table" }
}

resource "aws_route_table_association" "devopsfaza_association" {
  count          = 2
  subnet_id      = aws_subnet.devopsfaza_subnet[count.index].id
  route_table_id = aws_route_table.devopsfaza_route_table.id
}

# Restrict the default SG to deny all traffic — prevents accidental exposure if a resource lands here
resource "aws_default_security_group" "devopsfaza_default" {
  vpc_id = aws_vpc.devopsfaza_vpc.id
  tags   = { Name = "devopsfaza-default-sg-restricted" }
}

# ── Security Groups ───────────────────────────────────────────────────────────

resource "aws_security_group" "devopsfaza_cluster_sg" {
  vpc_id      = aws_vpc.devopsfaza_vpc.id
  description = "EKS cluster control plane security group"
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }
  tags = { Name = "devopsfaza-cluster-sg" }
}

# Allow nodes to reach the API server (required for kubectl exec, webhooks, metrics)
resource "aws_security_group_rule" "cluster_ingress_nodes_443" {
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.devopsfaza_node_sg.id
  security_group_id        = aws_security_group.devopsfaza_cluster_sg.id
  description              = "Allow inbound HTTPS from worker nodes"
}

resource "aws_security_group" "devopsfaza_node_sg" {
  vpc_id      = aws_vpc.devopsfaza_vpc.id
  description = "EKS worker node security group"
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.devopsfaza_vpc.cidr_block]
    description = "Allow all inbound traffic from within VPC"
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound traffic"
  }
  tags = { Name = "devopsfaza-node-sg" }
}

# ── EKS Cluster ───────────────────────────────────────────────────────────────

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

resource "aws_eks_cluster" "devopsfaza" {
  name     = "devopsfaza-cluster"
  role_arn = aws_iam_role.devopsfaza_cluster_role.arn

  vpc_config {
    subnet_ids         = aws_subnet.devopsfaza_subnet[*].id
    security_group_ids = [aws_security_group.devopsfaza_cluster_sg.id]
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  encryption_config {
    provider {
      key_arn = aws_kms_key.devopsfaza_eks_secrets.arn
    }
    resources = ["secrets"]
  }
}

# ── OIDC Provider (required for IRSA) ────────────────────────────────────────

data "tls_certificate" "cluster" {
  url = aws_eks_cluster.devopsfaza.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "cluster" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.cluster.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.devopsfaza.identity[0].oidc[0].issuer
}

# ── IAM Role for EBS CSI Driver (IRSA) ───────────────────────────────────────

resource "aws_iam_role" "ebs_csi_driver_role" {
  name = "devopsfaza-ebs-csi-driver-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.cluster.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:sub" = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
          "${replace(aws_iam_openid_connect_provider.cluster.url, "https://", "")}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ebs_csi_driver_policy" {
  role       = aws_iam_role.ebs_csi_driver_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

# ── EBS CSI Driver Addon ──────────────────────────────────────────────────────

resource "aws_eks_addon" "ebs_csi_driver" {
  cluster_name             = aws_eks_cluster.devopsfaza.name
  addon_name               = "aws-ebs-csi-driver"
  service_account_role_arn = aws_iam_role.ebs_csi_driver_role.arn

  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [
    aws_iam_openid_connect_provider.cluster,
    aws_iam_role_policy_attachment.ebs_csi_driver_policy,
  ]
}

# ── Node Group ────────────────────────────────────────────────────────────────

resource "aws_eks_node_group" "devopsfaza" {
  cluster_name    = aws_eks_cluster.devopsfaza.name
  node_group_name = "devopsfaza-node-group"
  node_role_arn   = aws_iam_role.devopsfaza_node_group_role.arn
  subnet_ids      = aws_subnet.devopsfaza_subnet[*].id

  scaling_config {
    desired_size = 3
    max_size     = 3
    min_size     = 3
  }

  instance_types = ["t2.medium"]

  remote_access {
    ec2_ssh_key               = var.ssh_key_name
    source_security_group_ids = [aws_security_group.devopsfaza_node_sg.id]
  }
}

# ── IAM Roles ─────────────────────────────────────────────────────────────────

resource "aws_iam_role" "devopsfaza_cluster_role" {
  name = "devopsfaza-cluster-role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "eks.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "devopsfaza_cluster_role_policy" {
  role       = aws_iam_role.devopsfaza_cluster_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role" "devopsfaza_node_group_role" {
  name = "devopsfaza-node-group-role"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "devopsfaza_node_group_role_policy" {
  role       = aws_iam_role.devopsfaza_node_group_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "devopsfaza_node_group_cni_policy" {
  role       = aws_iam_role.devopsfaza_node_group_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "devopsfaza_node_group_registry_policy" {
  role       = aws_iam_role.devopsfaza_node_group_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "devopsfaza_node_group_ebs_policy" {
  role       = aws_iam_role.devopsfaza_node_group_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}
```

### Checkov skip list for Terraform

Some Checkov checks flag intentional architectural decisions in this portfolio. Create `.checkov.yaml` at the repo root alongside the AWS skips (you'll add K8s skips in Day 04):

```yaml
# .checkov.yaml
skip-check:
  - CKV_AWS_130  # Public subnets intentional: EKS nodes require internet access; NAT gateway out of scope
  - CKV_AWS_382  # Open egress required: EKS nodes must reach ECR, AWS APIs, and pull container images
  - CKV2_AWS_11  # VPC flow logging requires IAM + CloudWatch setup; deferred as out of scope for this portfolio
  - CKV_AWS_38   # Public endpoint access intentional: local kubectl requires public endpoint; private VPN/bastion out of scope
  - CKV_AWS_39   # Public endpoint intentional: disabling requires VPC-internal access (bastion/VPN), out of scope for portfolio
```

These are not security failures — they are trade-offs explicitly chosen for a portfolio project (no NAT gateway, no private endpoint). Checkov requires they be explicitly acknowledged, which is what the skip annotations do.

### 3. Initialize Terraform

**[EKS Installer VM]**

```bash
# Initialize Terraform (use -upgrade if you add new providers like tls)
terraform init -upgrade

# Validate configuration
terraform validate

# Preview changes
terraform plan
```

### 4. Apply Terraform Configuration

**[EKS Installer VM]**

```bash
# Create infrastructure
terraform apply

# This takes 10-15 minutes
# Creates:
# - VPC with public subnets
# - EKS cluster
# - Node group (3 t2.medium instances)
# - Security groups
# - IAM roles
# - OIDC provider + EBS CSI driver addon
```

### 5. Configure kubectl

**[EKS Installer VM]**

```bash
# Update kubeconfig
aws eks update-kubeconfig --region us-east-1 --name devopsfaza-cluster

# Verify connection
kubectl get nodes

# You should see 3 nodes in Ready state
```

### 5.5. Assign Elastic IP to EKS Installer VM

**[EKS Installer VM]**

The EKS Installer VM is the jump host where Terraform state lives. If you stop and restart it between sessions, the IP changes — assign an Elastic IP so SSH access stays consistent.

1. AWS Console → EC2 → Elastic IPs → Allocate Elastic IP address → Allocate
2. Select the new Elastic IP → Actions → Associate Elastic IP address
3. Resource type: Instance → select the EKS Installer EC2 → Associate

> Elastic IPs are free while attached to a running instance. A small hourly charge applies when the instance is stopped.

# Part 1.5: Verify EBS CSI Driver and Install NGINX Ingress

Before deploying the application, verify the EBS CSI driver is active and install the NGINX Ingress controller.

**[EKS Installer VM]**

### EBS CSI Driver (provisioned via Terraform)

The EBS CSI driver is already provisioned as part of the Terraform config (`aws_eks_addon.ebs_csi_driver`). It requires an OIDC provider and IRSA role — both are defined in `eks/main.tf`.

Verify the driver pods are running:
```bash
kubectl get pods -n kube-system | grep ebs
# Expected: ebs-csi-controller pods Running (6/6), ebs-csi-node pods Running (3/3)
```

If the controller is in CrashLoopBackOff with `no EC2 IMDS role found`, the OIDC/IRSA config is missing — see `log-progress.md` Day 05 for the full fix.

> **Note:** Do NOT use `eksctl create addon` for the EBS CSI driver — it is managed by Terraform. Using eksctl would create a duplicate and cause state conflicts.

### Terraform vs eksctl: why some commands are absent from this guide

Tutorials that provision EKS manually (without Terraform) typically run two extra commands at this stage:

```bash
# 1. Associate the OIDC provider with the cluster
eksctl utils associate-iam-oidc-provider --region us-east-1 --cluster <cluster-name> --approve

# 2. Create an IAM role and wire it to a Kubernetes ServiceAccount (IRSA)
eksctl create iamserviceaccount \
  --region us-east-1 \
  --cluster <cluster-name> \
  --namespace kube-system \
  --name ebs-csi-controller-sa \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --approve
```

This project does not need those commands. Terraform handles both:

| Manual (`eksctl`) | Terraform equivalent |
|---|---|
| `eksctl utils associate-iam-oidc-provider` | `aws_iam_openid_connect_provider` resource in `main.tf` |
| `eksctl create iamserviceaccount` | `aws_iam_role.ebs_csi_driver_role` with OIDC trust policy + `service_account_role_arn` on the addon |

Running these `eksctl` commands on top of a Terraform-managed cluster would create duplicate IAM roles and potentially overwrite annotations that Terraform owns — breaking `terraform plan` and `terraform apply` on the next run.

### Install NGINX Ingress Controller

**[EKS Installer VM]**

```bash
# Add the ingress-nginx Helm repo
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Install the controller
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=LoadBalancer

# Wait for the LoadBalancer to get an external IP (2-3 minutes)
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

Note the `EXTERNAL-IP` from the output — this is the ELB hostname you'll use for DNS configuration in Day 07.

> If you plan to use a custom domain with cert-manager in Day 07, fix CoreDNS now before proceeding. AWS VPC DNS resolver fails on some TLDs (`.my`, `.io`) and cert-manager's self-check resolves the domain from inside the cluster — if CoreDNS can't resolve it, TLS issuance stalls silently. See Day 07 Part 2 for the fix.

# Part 2: Create Kubernetes Manifests

All manifest files live in `k8s/`. No `namespace.yaml` — the namespace is created imperatively (see Part 3).

### StorageClass

`k8s/sc.yaml` — provisions EBS gp3 volumes via the AWS EBS CSI driver.

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

### MySQL

`k8s/mysql.yaml` — Secret + 2 ConfigMaps + headless Service + StatefulSet.

The Secret holds the root password. One ConfigMap carries the database name; the other carries the `init.sql` that creates the `users` table on first boot. The headless Service (`clusterIP: None`) gives the StatefulSet pod a stable DNS name (`mysql-0.mysql.prod.svc.cluster.local`). The backend connects using just `mysql` as `DB_HOST` — Kubernetes resolves it through the headless service.

```yaml
---
apiVersion: v1
kind: Secret
metadata:
  name: mysql-secret
  namespace: prod
  labels:
    app: mysql
type: Opaque
stringData:
  MYSQL_ROOT_PASSWORD: Faza123

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-config
  namespace: prod
  labels:
    app: mysql
data:
  MYSQL_DATABASE: crud_app

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: mysql-initdb-config
  namespace: prod
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
  namespace: prod
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
  namespace: prod
  labels:
    app: mysql
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
      containers:
        - name: mysql
          image: mysql:8
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

### Backend

`k8s/backend.yaml` — Deployment + ClusterIP Service.

`DB_HOST: mysql` matches the headless service name above. `PORT` is omitted — `app.js` already defaults to 5000 via `process.env.PORT || 5000`. `JWT_SECRET` is kept because `auth.js` and `authController.js` use different fallback values (`'secretkey'` vs `'supersecret'`) — without a shared env var, tokens signed in one file won't verify in the other.

Liveness and readiness probes are configured on `/api/health`. If the health endpoint becomes unreachable, Kubernetes marks the pod NotReady and stops routing traffic to it. The liveness probe restarts a pod that's stuck; the readiness probe controls when traffic is sent.

> **Note (simplification):** `JWT_SECRET` is set as a plain `value` here intentionally, to keep this step focused on deployment mechanics. In a real environment, move it into a Kubernetes Secret and reference it with `secretKeyRef` — the same pattern used for `DB_PASSWORD` above. Never commit raw secret values to git in production.

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  namespace: prod
  labels:
    app: backend
spec:
  replicas: 3
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
          image: fazabillah/backend:latest
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

---
apiVersion: v1
kind: Service
metadata:
  name: backend-service
  namespace: prod
spec:
  selector:
    app: backend
  ports:
    - port: 5000
      targetPort: 5000
  type: ClusterIP
```

### Frontend

`k8s/frontend.yaml` — Deployment + ClusterIP Service.

> **Note on `imagePullPolicy`:** The frontend image uses the `:latest` tag. Without `imagePullPolicy: Always`, Kubernetes caches the image on each node and won't pull a newer version even after a new push. Add `imagePullPolicy: Always` to the frontend container spec to ensure each deployment picks up the latest image.

```yaml
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: prod
  labels:
    app: frontend
spec:
  replicas: 3
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
          image: fazabillah/frontend:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 80

---
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
  namespace: prod
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
  type: ClusterIP
```

### Ingress

`k8s/ingress.yaml` — routes `/api` to the backend and `/` to the frontend. No TLS here; Day 07 will add cert-manager + `learndevops.my`.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app-ingress
  namespace: prod
spec:
  ingressClassName: nginx
  rules:
    - host: <YOUR_ELB_HOSTNAME>
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

# Part 3: Deploy Application

> The kubectl steps below are a manual run to validate that the manifests work. In Day 06, ArgoCD will run `helm upgrade` automatically whenever the image tag in `charts/usermgmt/values.yaml` changes.

### 1. Create namespace and apply StorageClass

**[EKS Installer VM]**

```bash
kubectl create namespace prod
kubectl apply -f k8s/sc.yaml
```

### 2. Deploy MySQL

**[EKS Installer VM]**

```bash
kubectl apply -f k8s/mysql.yaml

# Watch mysql-0 come up — wait for Running before continuing
kubectl get pods -n prod -w
```

### 3. Deploy Backend, Frontend, Ingress

**[EKS Installer VM]**

```bash
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl apply -f k8s/ingress.yaml
```

### 4. Verify

**[EKS Installer VM]**

```bash
kubectl get all -n prod
kubectl get ingress -n prod
```

### 5. Note ELB Hostname for Day 07

**[EKS Installer VM]**

```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
# Copy the EXTERNAL-IP value — this is your ELB hostname
# You will point your DNS A records to this ELB's IPs in Day 07
```

If you have a real domain, stop here. Verify all pods show Running and move to Day 07.
Browser access via raw ELB hostname is only needed if you have no domain.

# Verify Deployment

**[EKS Installer VM]**

```bash
# Check all resources
kubectl get all -n prod

# Check ingress
kubectl get ingress -n prod

# Check logs
kubectl logs -f deployment/backend -n prod
kubectl logs -f deployment/frontend -n prod

# Describe pod if issues
kubectl describe pod <pod-name> -n prod
```

# Troubleshooting

### Pods stuck in Pending

```bash
# Check events
kubectl describe pod <pod-name> -n prod

# Common causes:
# - EBS CSI driver not installed (PVC stays in Pending)
# - Insufficient node resources
# - Image pull errors
```

### Backend can't connect to MySQL

```bash
# Check MySQL StatefulSet status
kubectl get statefulset mysql -n prod

# The StatefulSet pod is addressed as mysql-0.mysql.prod.svc.cluster.local
# Confirm DB_HOST in backend deployment matches the service name
kubectl get svc mysql -n prod

# Check backend logs
kubectl logs -f deployment/backend -n prod
```

### Ingress not routing traffic

```bash
# Verify ingress-nginx controller is running
kubectl get pods -n ingress-nginx

# Check ingress resource
kubectl describe ingress app-ingress -n prod

# Confirm the host field matches the actual DNS hostname
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

# Kubernetes Concepts Used

### StatefulSet (MySQL)
- Provides stable network identity and ordered pod startup
- `volumeClaimTemplates` automatically provisions a PVC per replica
- Uses headless service (clusterIP: None) for DNS-based pod addressing

### StorageClass (ebs-sc)
- Provisions EBS gp3 volumes via the AWS EBS CSI driver
- `WaitForFirstConsumer` waits until the pod is scheduled before creating the volume in the right AZ

### Services
- ClusterIP: Internal cluster access (backend, frontend)
- Headless: StatefulSet DNS (mysql-service)

### Ingress
- Single entry point for HTTP traffic
- Routes `/api` to backend, `/` to frontend
- Relies on the NGINX Ingress Controller LoadBalancer

### Secrets
- Store sensitive data (passwords, tokens)
- Injected as environment variables

### Namespaces
- Logical separation of resources; this project uses `prod`

# Self-Check

Four signals confirm the cluster and workloads are healthy:

```bash
# Cluster nodes are ready
kubectl get nodes
# Expected: 3 nodes, all STATUS=Ready
# If any node shows NotReady, the EKS node group may still be initializing — wait 2–3 minutes
```

```bash
# All prod pods running (no Pending, no CrashLoopBackOff)
kubectl get pods -n prod
# Expected: mysql-0 Running, 3x backend Running, 3x frontend Running
# CrashLoopBackOff on mysql-0 usually means the PVC didn't bind — check next command
```

```bash
# PVC bound (EBS volume provisioned)
kubectl get pvc -n prod
# Expected: mysql-data-mysql-0  Bound  ...
# If STATUS=Pending, the EBS CSI driver isn't set up correctly
```

```bash
# Ingress has an ELB address
kubectl get ingress -n prod
# Expected: ADDRESS column shows an ELB hostname (e.g., abc123.elb.amazonaws.com)
# Empty ADDRESS means the NGINX Ingress Controller service has no external IP yet
```

Pending pods and unbound PVCs are the two most common failure modes here. Both trace back to the EBS CSI driver setup — if either shows up, paste the output of `kubectl describe pod mysql-0 -n prod` or `kubectl describe pvc mysql-data-mysql-0 -n prod` for diagnosis.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] Terraform installed and AWS CLI configured
- [ ] EKS cluster created with Terraform (`devopsfaza-cluster`, 3x t2.medium nodes)
- [ ] kubectl installed and configured to access cluster
- [ ] EBS CSI driver active (provisioned via Terraform with OIDC + IRSA)
- [ ] NGINX Ingress Controller installed via Helm
- [ ] ELB hostname noted from `kubectl get svc -n ingress-nginx`
- [ ] CoreDNS fixed to use public resolvers (if using non-standard TLD — see Day 07 Part 2)
- [ ] StorageClass `ebs-sc` created
- [ ] Namespace `prod` created
- [ ] MySQL Secret and ConfigMaps created (via k8s/mysql.yaml)
- [ ] MySQL StatefulSet deployed and pod Running
- [ ] Backend deployed (3 replicas) and running
- [ ] Frontend deployed (3 replicas) and running
- [ ] Ingress resource created and routing traffic
- [ ] Can access application via Ingress hostname
- [ ] Understand StatefulSet vs Deployment for stateful workloads

# What You Learned

- Infrastructure as Code with Terraform
- EKS cluster architecture
- Kubernetes deployment patterns
- Service networking in Kubernetes
- Secret management
- Persistent storage in Kubernetes

# Next

**Day 4:** Helm Charts — package K8s manifests into a deployable chart.

# Notes

- EKS costs money ($0.10/hour for control plane + EC2 costs)
- Destroy resources when not using: `terraform destroy`
- Document your cluster configuration
- This is the foundation for the ArgoCD GitOps loop in Day 06
