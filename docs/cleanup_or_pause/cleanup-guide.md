# AWS Cleanup Guide

This documents the full teardown sequence for the 3-tier portal project. The EKS control plane runs at ~$0.10/hour — don't leave it running after the project is done.

---

# Before You Start

Get a picture of what's running before touching anything.

```bash
# Set context for the cluster
aws eks update-kubeconfig --name devopsfaza-cluster --region us-east-1

# List everything running
kubectl get all -A

# Check Terraform state
cd eks
terraform show
```

If you haven't already, enable AWS Cost Explorer and set a billing alert so you catch anything that doesn't get cleaned up.

---

# Why Order Matters

Load balancers must be removed **before** `terraform destroy`.

When Kubernetes creates a `LoadBalancer`-type Service (Grafana, NGINX Ingress), AWS provisions an ELB/ALB outside of Terraform's awareness. If those services still exist when `terraform destroy` runs, Terraform can't delete the VPC — the load balancers are still attached to it. They keep billing, and you're left with dangling resources you have to hunt down manually.

The rule: uninstall Helm charts first, wait for PVCs to clear, then destroy Terraform.

If you skipped the Helm uninstalls and already ran `terraform destroy` — or the EKS API server DNS is gone so `kubectl` can't connect — clean up manually before retrying:

```bash
# Find ELB security groups left by the K8s cloud controller
aws ec2 describe-security-groups --region us-east-1 \
  --filters Name=vpc-id,Values=<vpc-id> \
  --query 'SecurityGroups[*].[GroupId,GroupName]' --output json
# Look for names like: k8s-elb-* or k8s-sg-*

# Delete each one
aws ec2 delete-security-group --region us-east-1 --group-id <sg-id>

# Check for orphaned ENIs
aws ec2 describe-network-interfaces --region us-east-1 \
  --filters Name=vpc-id,Values=<vpc-id> --output json
# If any exist, delete them:
aws ec2 delete-network-interface --region us-east-1 --network-interface-id <eni-id>

# Check for classic load balancers still attached to the VPC
aws elb describe-load-balancers --region us-east-1 \
  --query 'LoadBalancerDescriptions[*].[LoadBalancerName,VPCId]' --output table
aws elb delete-load-balancer --region us-east-1 --load-balancer-name <name>
```

Once all of the above return empty, retry `terraform destroy`.

---

## Step 1 — Kubernetes Cleanup

```bash
aws eks update-kubeconfig --name devopsfaza-cluster --region us-east-1
```

Uninstall the application chart:

```bash
helm uninstall usermgmt -n prod
```

Uninstall monitoring:

```bash
helm uninstall prometheus -n monitoring
```

Uninstall ingress:

```bash
helm uninstall ingress-nginx -n ingress-nginx
```

Uninstall cert-manager:

```bash
helm uninstall cert-manager -n cert-manager
```

Uninstalling cert-manager removes the ClusterIssuer and stops certificate renewals. Do this before destroying Terraform or the OIDC/IAM bindings will be gone before the controller can clean up.

cert-manager will print a notice that several CRDs were kept due to resource policy — this is expected. The namespace deletion below handles them.

Delete PVCs explicitly before deleting namespaces. The StorageClass `ebs-sc` uses `reclaimPolicy: Retain` — deleting a namespace removes the PVC objects but does **not** delete the underlying EBS volumes. You must delete PVCs first so Kubernetes sends the delete signal, then verify in the console (Step 3) that the volumes are actually gone.

First, check what PVCs actually exist — names may differ from what's listed here:

```bash
kubectl get pvc -A
```

Then delete by namespace (safer than guessing names):

```bash
kubectl delete pvc --all -n prod
kubectl delete pvc --all -n monitoring
```

Note: `helm uninstall usermgmt -n prod` also deletes the `prod` namespace itself, so the PVC in `prod` may already be gone by this point. `kubectl get pvc -A` will confirm.

Wait for PVCs to clear:

```bash
kubectl get pvc -A
# Should return: No resources found.
```

Check for Released PersistentVolumes — with `reclaimPolicy: Retain`, PVs survive PVC deletion and must be removed manually:

```bash
kubectl get pv -A
```

If any PVs show `Released` status, delete them explicitly:

```bash
kubectl delete pv <pv-name> [<pv-name> ...]
```

The underlying EBS volumes still exist in AWS after this. Delete them manually in the console at Step 3.

Delete namespaces. ArgoCD was installed via `kubectl apply` (not Helm) and its server was patched to `LoadBalancer` type — deleting the `argocd` namespace will trigger the cloud controller to remove the ELB before the namespace finalizes.

Note: if `helm uninstall usermgmt` already removed the `prod` namespace, the command below will print `Error from server (NotFound): namespaces "prod" not found` — that's fine, everything else still proceeds:

```bash
kubectl delete namespace prod monitoring cert-manager ingress-nginx argocd
```

---

## Step 2 — Terraform Destroy

```bash
cd eks
terraform destroy -auto-approve
```

This removes: VPC, subnets, internet gateway, EKS cluster, node group (3×t2.medium), IAM roles (cluster role, node group role, EBS CSI driver role), security groups, OIDC provider.

---

## Step 3 — Verify in AWS Console

After the destroy completes, check manually. Terraform can miss things.

**EC2 → Volumes:** No volumes in `available` or `released` state tagged with the project. The 5Gi MySQL and 5Gi Prometheus volumes should be gone. If any remain (the Retain reclaimPolicy can leave them behind), delete them manually — look for volumes tagged with `devopsfaza` or sized at 5Gi with no attachment.

**EC2 → Load Balancers:** None remaining. If any show up here, delete them manually — they're the orphans that slipped through.

**VPC → Your VPCs:** Project VPC gone. If the VPC is stuck, it's because something is still attached — check for remaining ENIs, subnets, or internet gateways.

**IAM → Roles:** No `devopsfaza-*` roles remain. Also check for `eks-installer-role-v2` — this role was created manually (outside Terraform) to fix the `eks:*` permission issue and will not be removed by `terraform destroy`. Delete it manually if present.

**KMS → Customer managed keys:** The `devopsfaza-eks-secrets-key` will show as "Pending deletion" with a 7-day window. This is expected — no action needed. The $1/month charge stops when the deletion window expires.

**EKS → Clusters:** Cluster gone.

---

## Step 4 — EC2 Instances

These aren't managed by Terraform if they were launched manually.

Day 1 instance (t2.medium, used for local app run):

```bash
aws ec2 terminate-instances --instance-ids <instance-id>
```

Day 3 EKS Installer VM (t3.small, Ubuntu 22.04 — provisioned in Day 03 Part 0):

```bash
aws ec2 terminate-instances --instance-ids <instance-id>
```

Before terminating, check whether "Delete on Termination" was enabled for their root volumes. In the EC2 console: Instance → Storage → Root device → check the `Delete on termination` column. If it's `No`, delete the EBS root volumes manually after termination.

After terminating the EKS Installer VM, release its Elastic IP. An unattached Elastic IP bills at ~$0.005/hour (~$3.60/month):

EC2 → Elastic IPs → select the address associated with the EKS Installer VM → Actions → Release Elastic IP address.

---

## Step 5 — DockerHub

Delete the image repositories created during the project:

- `fazabillah/frontend`
- `fazabillah/backend`

Or, if you want to stay within the free tier's 1 private repo limit without deleting entirely, delete all tags inside each repo instead.

---

## Step 6 — GitHub Actions Secrets

This project uses GitHub Actions for CI/CD — there is no external webhook to remove. The workflow file (`.github/workflows/ci-cd.yml`) is repo-internal and doesn't need cleanup.

Optionally, remove the repository secrets that are no longer needed:

Repo → Settings → Secrets and variables → Actions → delete `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `GH_PAT`, `SONAR_TOKEN`, `SONAR_HOST_URL`.

---

## Step 7— Terraform State Backend

Terraform state for this project is stored locally at `eks/terraform.tfstate`. There is no S3 bucket or DynamoDB lock table to clean up. Confirm the file is gone after `terraform destroy` completes, or delete it manually if needed.

---

# Final Billing Check

- AWS Billing → Bills: no unexpected line items
- AWS Cost Explorer → Last 7 days: charges winding down, not flat

Also scan for things that are easy to forget:

- **Route 53 hosted zones:** The `learndevops.my` hosted zone costs $0.50/month even with no traffic — delete it if the domain is no longer in use
- **ACM certificates:** Free, but worth cleaning up
- **S3 buckets:** If used for log storage — delete contents, then delete bucket
- **CloudWatch Log Groups:** All 5 EKS log types were enabled (`api`, `audit`, `authenticator`, `controllerManager`, `scheduler`). These log groups are not managed by Terraform and persist after `terraform destroy`. Delete them:

```bash
for log_type in api audit authenticator controllerManager scheduler; do
  aws logs delete-log-group \
    --log-group-name "/aws/eks/devopsfaza-cluster/${log_type}" \
    --region us-east-1
done
```

Or in the console: CloudWatch → Log groups → filter by `devopsfaza` → select all → Actions → Delete.
