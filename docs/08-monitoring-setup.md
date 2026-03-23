# Day 8: Monitoring Setup

**Branch:** `feature/observability`

## What You'll Learn

Set up complete monitoring stack with Prometheus and Grafana for Kubernetes cluster observability.

## Why Monitoring Matters

- Track application health and performance
- Detect issues before users notice
- Understand resource usage
- Debug production problems
- Plan capacity and scaling

# Part 1: Install Prometheus Stack with Helm

> **[EKS Installer VM]** — All commands in this guide run on the EKS Installer VM, the same EC2 instance used since Day 3. Helm and kubectl are already installed there. SSH in before proceeding.

### 1. Add Prometheus Helm Repository

**[EKS Installer VM]**

```bash
# Add repository
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts

# Update repositories
helm repo update

# Search for chart
helm search repo prometheus-community
```

### 2. Install Prometheus Stack

**[EKS Installer VM]**

Create `monitoring/values.yaml` in the project root on the VM:

```yaml
grafana:
  adminPassword: admin123

prometheus:
  prometheusSpec:
    retention: 7d
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: ebs-sc
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 5Gi

alertmanager:
  enabled: false   # Not used in this project
```

```bash
# Create monitoring namespace
kubectl create namespace monitoring

# Install Prometheus stack using values file
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --values monitoring/values.yaml

# Check installation
kubectl get pods -n monitoring -w
```

### 3. Verify Installation

**[EKS Installer VM]**

```bash
# Check all resources
kubectl get all -n monitoring

# You should see:
# - prometheus-operator
# - prometheus-server
# - grafana
# - node-exporter (on each node)
# - kube-state-metrics
# Note: alertmanager is disabled for this project
```

# Part 2: Access Grafana

### Port Forward (default)

**[EKS Installer VM]**

```bash
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80
```

`kubectl port-forward` binds to `localhost` on the EKS Installer VM — not your laptop. To reach `http://localhost:3000` in your local browser, open a separate terminal on your local machine and set up an SSH tunnel:

```bash
# Run this on your LOCAL machine (replace with your VM's IP)
ssh -L 3000:localhost:3000 ubuntu@<EKS-INSTALLER-VM-IP> -N
```

Keep both the port-forward terminal (on the VM) and the SSH tunnel terminal (on your local machine) open while you use Grafana. Then open `http://localhost:3000` in your browser.

### LoadBalancer (alternative)

**[EKS Installer VM]**

If you want persistent access without managing tunnels:

```bash
kubectl patch svc prometheus-grafana -n monitoring -p '{"spec": {"type": "LoadBalancer"}}'

# Wait ~2 minutes, then get the external hostname
kubectl get svc prometheus-grafana -n monitoring
```

Access Grafana directly via the ELB hostname on port 80. Trade-off: this spins up an additional AWS ELB (~$0.025/hr ongoing cost). Port-forward + SSH tunnel is free and sufficient for a portfolio project.

### Get Grafana Credentials

**[EKS Installer VM]**

```bash
# Username: admin
# Password: admin123  (set in values.yaml above)

# If you need to retrieve it from the secret:
kubectl get secret -n monitoring prometheus-grafana \
  -o jsonpath="{.data.admin-password}" | base64 --decode
```

# Part 3: Configure Dashboards

### Import Pre-Built Dashboards

1. Login to Grafana
2. Left sidebar → Dashboards → Import
3. Enter dashboard IDs:

**Essential Dashboards:**

- **1860** - Node Exporter Full (node-level metrics: CPU, memory, disk, network)
- **15661** - K8S Dashboard (Kubernetes resource overview: nodes, pods, containers)

Note: dashboards 315, 3119, 6417, 7249, 9614, and 17900 are outdated or incompatible — they will show mostly N/A panels with kube-prometheus-stack.

**Import process:**
1. Enter dashboard ID
2. Click Load
3. Select Prometheus data source
4. Click Import

### What to focus on in dashboard 1860 (Node Exporter Full)

Dashboard 1860 has many sections. Most are for deep kernel-level debugging — not day-to-day ops. Keep these expanded:

- **Quick CPU / Mem / Disk** — top row gauges: CPU %, RAM %, disk usage %, uptime. Instant node health at a glance.
- **Basic CPU / Mem / Net / Disk** — the four time-series graphs below. Use these to spot spikes, saturation trends, and network anomalies.
- **System Processes** — watch for unexpected process count growth (runaway containers, fork issues).
- **Storage Disk** — I/O latency and throughput. Important when MySQL or any stateful workload slows down.
- **Storage Filesystem** — disk fill rate over time. Catches a full disk before it kills the node.
- **Network Traffic** — bandwidth in/out per interface. Useful when debugging slow API responses.

Collapse and ignore these — they exist for rare deep-dive debugging, not normal monitoring:

- **Memory Meminfo / Vmstat** — kernel memory internals, only relevant for OOM debugging
- **System Timesync** — clock drift, only matters for distributed systems like Kafka or Cassandra
- **System Misc** — entropy, file descriptors, interrupts
- **Hardware Misc** — temperature, fan speed, NUMA — irrelevant on EC2
- **Systemd** — service unit states, more useful on bare metal than EKS nodes
- **Network Sockstat / Netstat** — TCP connection internals, only for connection exhaustion debugging
- **Node Exporter** — meta-metrics about the exporter itself

### What to focus on in dashboard 15661 (K8S Dashboard)

This dashboard is already well-structured — all three sections are worth keeping open. Use the dropdowns at the top (`Namespace`, `Pod`, `Microservice`) to filter down to your application.

- **Node Resource Overview** — CPU, memory, and disk per node. Tells you which node is under pressure. Drill into a specific node using the `Nodes` dropdown.
- **Pod Resource Overview** — CPU and memory per pod. First place to check when a pod is slow or getting OOMKilled. Filter by `Namespace: prod` to scope it to your app.
- **Microservices (Container Name) Resource Overview** — same as pods but per container. Use this to isolate `backend`, `frontend`, or `mysql` specifically.

These three sections map directly to the three questions you ask during an incident: which node, which pod, which container. Set `Namespace: prod` as the default filter when you open this dashboard.

### Create Custom Dashboard for Application

1. Dashboards → New → New dashboard → Add visualization
2. Select Prometheus as the data source
3. Switch from Builder to **Code** mode in the query editor
4. Add these panels:

**Panel 1: Backend CPU Usage** — visualization type: Time series
```promql
sum(rate(container_cpu_usage_seconds_total{namespace="prod", pod=~"backend.*"}[5m])) by (pod)
```

**Panel 2: Backend Memory Usage** — visualization type: Time series
```promql
sum(container_memory_working_set_bytes{namespace="prod", pod=~"backend.*"}) by (pod)
```

**Panel 3: Pod Restart Count** — visualization type: Stat
```promql
sum(kube_pod_container_status_restarts_total{namespace="prod"}) by (pod)
```

Note: a "Backend Request Rate" panel (`http_requests_total`) is not included — that metric requires `prom-client` instrumentation in the backend code and a `/metrics` endpoint, neither of which are part of this project. The three panels above use infrastructure metrics from kube-state-metrics and cadvisor, which work out of the box.

5. Save dashboard with name "3-Tier Application Monitoring"

# Part 4: Prometheus Query Reference

AlertManager is disabled in this project (configured in `values.yaml`). Use Grafana's built-in alerting if you need notifications.

For ad-hoc queries, use the Prometheus UI or the Grafana Explore tab.

# Part 5: Access Prometheus

**[EKS Installer VM]**

```bash
# Port forward Prometheus
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090
```

Same as Grafana — run the SSH tunnel on your local machine to reach the UI in your browser:

```bash
# Run this on your LOCAL machine
ssh -L 9090:localhost:9090 ubuntu@<EKS-INSTALLER-VM-IP> -N
# Access: http://localhost:9090
```

### Useful Prometheus Queries

**Check pods running:**
```promql
kube_pod_status_phase{namespace="prod"}
```

**Memory usage by pod:**
```promql
container_memory_working_set_bytes{namespace="prod"}
```

**CPU usage by pod:**
```promql
rate(container_cpu_usage_seconds_total{namespace="prod"}[5m])
```

**Network traffic:**
```promql
rate(container_network_receive_bytes_total{namespace="prod"}[5m])
```

# Part 6: Application Metrics

Application-level metrics instrumentation (prom-client + ServiceMonitor) is not part of this project. `prom-client` is not installed in the backend and the `/metrics` endpoint does not exist. The infrastructure metrics from node-exporter and kube-state-metrics are sufficient for this portfolio.

# Troubleshooting

### Grafana not accessible

**[EKS Installer VM]**

```bash
# Check Grafana pod
kubectl get pods -n monitoring | grep grafana

# Check logs
kubectl logs -f deployment/prometheus-grafana -n monitoring

# Restart pod if needed
kubectl rollout restart deployment/prometheus-grafana -n monitoring
```

### Dashboard shows no data

```bash
# Verify Prometheus data source in Grafana
# Settings → Data Sources → Prometheus
# Test connection

# Check query syntax in panel
# Status → Explore → Run test queries
```

# Self-Check

Three signals confirm the monitoring stack is running and collecting data. Run the port-forwards on the EKS Installer VM first:

```bash
kubectl port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 -n monitoring &
kubectl port-forward svc/prometheus-grafana 3000:80 -n monitoring &
```

Then run these checks from the EKS Installer VM:

```bash
# All monitoring pods running
kubectl get pods -n monitoring
# Expected: prometheus-*, grafana-*, alertmanager-* all Running
# Pending pods usually mean storage isn't available — check your storageClass setting in values.yaml
```

```bash
# Prometheus targets are up
curl -s "http://localhost:9090/api/v1/query?query=up" | \
  python3 -c "import sys,json; r=json.load(sys.stdin); print(len(r['data']['result']), 'targets up')"
# Expected: several targets up (exact number varies by cluster size)
# 0 targets means Prometheus isn't scraping anything — check the ServiceMonitor resources
```

```bash
# Grafana login works
curl -s -o /dev/null -w "%{http_code}" \
  http://admin:admin123@localhost:3000/api/org
# Expected: 200
# 401 means the password in values.yaml didn't apply — try the default "prom-operator" password
```

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] `monitoring/values.yaml` created on EKS Installer VM with `adminPassword: admin123`, `storageClass: ebs-sc`, 5Gi storage, alertmanager disabled
- [ ] Prometheus stack installed via Helm with values file
- [ ] Grafana accessible via port-forward + SSH tunnel (localhost:3000 in local browser)
- [ ] Login works with admin / admin123
- [ ] Pre-built dashboards imported (1860, 15661)
- [ ] Custom application dashboard created with namespace `prod`

# What You Learned

- Prometheus architecture and components
- Grafana dashboard creation
- PromQL query language
- Kubernetes monitoring best practices

# Next

This is the final day of the series. The full DevSecOps loop is complete: code push → CI pipeline → image push → manifest update → ArgoCD sync → production deploy → monitoring.

# Notes

- Prometheus stores metrics for 7 days (configurable)
- Monitor resource usage of monitoring stack itself
- Set up alerts for critical issues
- Create runbooks for common alerts
- This monitoring setup is production-grade
