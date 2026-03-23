# Cluster Teardown and Rebuild (AWS Cost Saving)

Use this guide when stopping work for a few days and the cluster doesn't need to stay up. Running costs without this: ~$5–7/day (EKS control plane + 3x t2.medium nodes). Teardown brings that to near zero.

**Key constraint:** the EKS Installer VM must be stopped, not terminated. Terraform state lives on its disk.

---

## Part 1: Before You Destroy — Record Current Values

Two values change every rebuild. Note them now.

```bash
# EKS API endpoint (needed later for Jenkins Jenkinsfile + k8-token)
kubectl cluster-info

# ELB hostname (needed for Cloudflare DNS update)
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

Save both. A local text file is fine.

---

## Part 2: Delete Kubernetes Resources First

Do this before `terraform destroy`. If the ELB is still running when Terraform tries to delete the VPC, it will fail — the ELB holds onto subnet attachments and leaves orphaned resources behind.

```bash
kubectl delete -f k8s/ingress.yaml -n prod
kubectl delete -f k8s/clusterissuer.yaml
helm uninstall ingress-nginx -n ingress-nginx
kubectl delete -f k8s/backend.yaml -n prod
kubectl delete -f k8s/frontend.yaml -n prod
kubectl delete -f k8s/mysql.yaml -n prod
kubectl delete -f k8s/sc.yaml
kubectl delete namespace prod
kubectl delete namespace ingress-nginx
kubectl delete namespace cert-manager
```

Wait for the ELB to fully decommission before moving on (2–3 min):

```bash
# Returns nothing when ELB is gone
kubectl get svc -n ingress-nginx 2>/dev/null

# Also confirm in AWS Console → EC2 → Load Balancers
```

---

## Part 3: Check for Orphaned EBS Volumes

The MySQL PVC uses `reclaimPolicy: Retain`. The EBS disk may survive as an unattached volume still billing you.

```bash
aws ec2 describe-volumes \
  --filters Name=status,Values=available \
  --query 'Volumes[*].[VolumeId,Size,Tags]' \
  --output table
```

Note any volume IDs. Delete them after `terraform destroy` if they weren't cleaned up automatically.

---

## Part 4: Back Up Terraform State

```bash
cp eks/terraform.tfstate eks/terraform.tfstate.backup
```

Optional S3 backup:

```bash
aws s3 cp eks/terraform.tfstate s3://<your-bucket>/backups/terraform.tfstate
```

---

## Part 5: Stop (Not Terminate) the EKS Installer VM

AWS Console → EC2 → select EKS Installer VM → Instance State → **Stop**.

Do not terminate. Terminating destroys the disk, and the next `terraform apply` will attempt to recreate IAM roles that already exist in AWS and fail with conflicts.

Optionally stop the Jenkins VM too — nothing to deploy to anyway.

---

## Part 6: terraform destroy

```bash
cd eks
terraform destroy
```

Takes 10–15 minutes. Watch for errors about resources that couldn't be deleted — usually security groups still attached to ENIs left over from the ELB.

Post-destroy, verify in AWS Console:
- EKS: cluster gone
- EC2 → Load Balancers: none remaining
- EC2 → Volumes: no `available` EBS volumes from this cluster
- VPC: the cluster VPC deleted

If orphaned EBS volumes remain:

```bash
aws ec2 delete-volume --volume-id <volume-id>
```

---

## Part 7: Rebuild — terraform apply

Start the EKS Installer VM first (AWS Console → EC2 → Start), then SSH in.

```bash
cd eks
terraform apply
aws eks update-kubeconfig --region us-east-1 --name devopsfaza-cluster
kubectl get nodes
# Wait for all 3 nodes to show Ready
```

---

## Part 8: Reinstall NGINX Ingress

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=LoadBalancer

# Watch until EXTERNAL-IP is assigned (2-3 min)
kubectl get svc -n ingress-nginx ingress-nginx-controller -w
```

---

## Part 9: Update Cloudflare DNS

The new ELB has different IPs. Resolve the new hostname to get them.

```bash
# Get new ELB hostname
kubectl get svc -n ingress-nginx ingress-nginx-controller

# Resolve to IPs
nslookup <new-elb-hostname>
```

In Cloudflare → DNS:
- Delete the old A records for `learndevops.my`
- Add new A records pointing to the new ELB IPs

Verify propagation before continuing:

```bash
nslookup learndevops.my 8.8.8.8
# Must return the new ELB IPs
```

---

## Part 10: Fix CoreDNS

CoreDNS config resets on every cluster rebuild. The `.my` TLD doesn't resolve with the default upstream — re-apply the fix.

```bash
kubectl edit configmap coredns -n kube-system
```

Change:
```
forward . /etc/resolv.conf
```
To:
```
forward . 8.8.8.8 1.1.1.1
```

```bash
kubectl rollout restart deployment/coredns -n kube-system

# Verify DNS resolves from inside the cluster
kubectl run dns-test --image=busybox --restart=Never --rm -it -- nslookup learndevops.my
# Must return IPs before moving on
```

---

## Part 11: Reinstall cert-manager + ClusterIssuer

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

kubectl get pods -n cert-manager

kubectl apply -f k8s/clusterissuer.yaml
kubectl get clusterissuer letsencrypt-prod
```

---

## Part 12: Redeploy Application

```bash
kubectl create namespace prod
kubectl apply -f k8s/sc.yaml
kubectl apply -f k8s/mysql.yaml -n prod

# Wait for mysql-0 Running before deploying backend
kubectl get pods -n prod -w

kubectl apply -f k8s/backend.yaml -n prod
kubectl apply -f k8s/frontend.yaml -n prod
kubectl apply -f k8s/ingress.yaml -n prod
```

---

## Part 13: Update Jenkins

The EKS API endpoint changes with every new cluster.

Get the new endpoint:

```bash
kubectl cluster-info
# Returns: https://<new-id>.gr7.us-east-1.eks.amazonaws.com
```

Get the new service account token:

```bash
kubectl get secret mysecretname -n prod -o jsonpath='{.data.token}' | base64 -d
```

In Jenkins:
1. Manage Jenkins → Credentials → find `k8-token` → update with new token
2. Open `Jenkinsfile` → update both `serverUrl` values to the new endpoint
3. Commit and push the Jenkinsfile change

---

# Teardown Checklist

- [ ] Recorded EKS API endpoint and ELB hostname
- [ ] Deleted all k8s resources (ingress → helm uninstall ingress-nginx → workloads → namespaces)
- [ ] Waited for ELB to fully decommission (confirmed in AWS Console)
- [ ] Checked for orphaned EBS volumes
- [ ] Backed up terraform.tfstate
- [ ] Stopped EKS Installer VM (not terminated)
- [ ] Stopped Jenkins VM (optional)
- [ ] `terraform destroy` completed with no errors
- [ ] Verified VPC and Load Balancers are gone in AWS Console
- [ ] Deleted any orphaned EBS volumes

# Rebuild Checklist

- [ ] EKS Installer VM started
- [ ] `terraform apply` complete, all 3 nodes Ready
- [ ] NGINX Ingress installed, ELB hostname obtained
- [ ] New ELB IPs resolved via nslookup
- [ ] Cloudflare A records updated to new IPs
- [ ] DNS propagation confirmed (`nslookup learndevops.my 8.8.8.8`)
- [ ] CoreDNS patched to use 8.8.8.8 and 1.1.1.1
- [ ] DNS resolves from inside cluster (busybox nslookup test passes)
- [ ] cert-manager installed and ClusterIssuer Ready
- [ ] All k8s manifests applied, mysql-0 Running
- [ ] Backend and frontend Running
- [ ] Ingress created, TLS cert issued
- [ ] Application accessible at https://learndevops.my
- [ ] Jenkins k8-token updated with new token
- [ ] Jenkinsfile serverUrl updated and committed
