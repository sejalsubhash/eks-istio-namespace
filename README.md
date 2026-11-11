# AWS EKS-to-EKS Three-Tier Application Migration Lab

## 1. Project overview

This lab demonstrates how to migrate a Kubernetes namespace containing a
three-tier application from one Amazon EKS cluster to another EKS
cluster in AWS.

The migration is performed between two independent clusters in the
`ap-south-1` region:

  Item              Source                                           Destination
  ----------------- ------------------------------------------------ -----------------
  EKS cluster       `source-cluster`                                 `dest-cluster`
  kubectl context   `source`                                         `destination`
  Node group        `source-node-grp`                                `dest-node-grp`
  Namespace         `three-tier`                                     `three-tier`
  Application       React + Nginx frontend, Node.js backend, MySQL   Same
  Istio             Installed                                        Installed

AWS account used in this lab: `779074487325`\
AWS region: `ap-south-1`\
Administration host: `ec2-user@ip-10-10-7-129`

> **Important:** The source and destination are separate EKS clusters. A
> namespace is not physically moved between clusters by Kubernetes. We
> recreated the namespace and its resources on the destination, migrated
> the database data, deployed the application, and tested it.

## 2. Architecture

``` text
                         Users / Browser
                                |
                +---------------+---------------+
                |                               |
          Source NLB                       Destination NLB
                |                               |
        Istio Ingress Gateway           Istio Ingress Gateway
                |                               |
          Istio Gateway                    Istio Gateway
          VirtualService                   VirtualService
                |                               |
        frontend-service                  frontend-service
                |                               |
        React + Nginx Pod                 React + Nginx Pod
                |                               |
        backend-service                   backend-service
                |                               |
        Node.js Backend Pod               Node.js Backend Pod
                |                               |
         mysql-service                     mysql-service
                |                               |
          MySQL Pod                         MySQL Pod
                |                               |
         Source PVC / EBS                 Destination PVC / EBS
```

The application components are:

-   **Frontend:** React application built and served by Nginx, listening
    on container port `80`.
-   **Backend:** Node.js/Express API, listening on port `3000`.
-   **Database:** MySQL 8.0, database `appdb`, table `users`.
-   **Service discovery:** Kubernetes ClusterIP services.
-   **Persistent storage:** EBS-backed PersistentVolumeClaims using the
    `gp3` StorageClass.
-   **Service mesh / ingress:** Istio control plane, ingress gateway,
    Gateway, and VirtualService.

## 3. What was completed

1.  Prepared access to both EKS clusters.
2.  Configured separate kubectl contexts for source and destination.
3.  Checked EKS node groups and worker nodes.
4.  Configured EBS CSI driver permissions using EKS Pod Identity.
5.  Created a `gp3` StorageClass on both clusters.
6.  Installed Istio on both clusters.
7.  Created the `three-tier` namespace on both clusters.
8.  Enabled Istio automatic sidecar injection on the namespace.
9.  Created the MySQL credentials Secret on both clusters.
10. Deployed MySQL on the source cluster with persistent storage.
11. Deployed the backend and frontend on the source cluster.
12. Tested source database connectivity and application APIs.
13. Exported the source MySQL database using `mysqldump`.
14. Deployed MySQL on the destination cluster.
15. Restored the initial database dump into destination MySQL.
16. Deployed the backend and frontend on the destination cluster.
17. Tested destination database connectivity and application APIs.
18. Configured Istio Gateway and VirtualService on both clusters.
19. Accessed both applications through their respective Istio ingress
    Network Load Balancers.
20. Updated Alice's email in the source database.
21. Created a fresh final database dump after the source update.
22. Restored that final dump into destination MySQL.
23. Queried the destination database and confirmed the updated email.

**Current status:** The application and database migration exercise is
complete and verified. Both clusters remain available. A final DNS or
client traffic cutover from source to destination has not been
performed.

------------------------------------------------------------------------

# 4. Detailed implementation steps

Commands below are shown in the order of the lab. Run them from the
administration EC2 host unless otherwise mentioned.

## Step 1 --- Confirm AWS identity and region

``` bash
aws sts get-caller-identity
aws configure get region
```

**What these commands do**

-   `aws sts get-caller-identity` displays the AWS account and IAM
    identity currently being used.
-   `aws configure get region` checks the configured default AWS region.

**Why**

Before changing EKS resources, we must confirm that the AWS CLI is
operating against the intended account and region.

Expected account:

``` text
779074487325
```

Expected region:

``` text
ap-south-1
```

## Step 2 --- Prepare access to both EKS clusters

The clusters were provisioned before the application migration work. We
configured kubeconfig access for both clusters.

Typical commands for configuring access are:

``` bash
aws eks update-kubeconfig \
  --region ap-south-1 \
  --name source-cluster \
  --alias source

aws eks update-kubeconfig \
  --region ap-south-1 \
  --name dest-cluster \
  --alias destination
```

**What they do**

-   Retrieve cluster connection details and authentication
    configuration.
-   Add each cluster to the local kubeconfig file.
-   Assign easy-to-remember context names.

Check the contexts:

``` bash
kubectl config get-contexts
```

Check the cluster API access:

``` bash
kubectl get nodes --context source
kubectl get nodes --context destination
```

**Why**

A context lets us explicitly choose which cluster receives a Kubernetes
command. This is essential when managing two clusters from one terminal.

> Always include `--context source` or `--context destination` in this
> lab. Avoid relying on whichever context happens to be active.

## Step 3 --- Check EKS cluster and node group status

The two clusters used in this lab:

-   Source node group: `source-node-grp`
-   Destination node group: `dest-node-grp`

Example checks:

``` bash
aws eks describe-cluster \
  --name source-cluster \
  --region ap-south-1 \
  --query 'cluster.status'

aws eks describe-cluster \
  --name dest-cluster \
  --region ap-south-1 \
  --query 'cluster.status'
```

Check node groups:

``` bash
aws eks describe-nodegroup \
  --cluster-name source-cluster \
  --nodegroup-name source-node-grp \
  --region ap-south-1

aws eks describe-nodegroup \
  --cluster-name dest-cluster \
  --nodegroup-name dest-node-grp \
  --region ap-south-1
```

Check Kubernetes worker nodes:

``` bash
kubectl get nodes -o wide --context source
kubectl get nodes -o wide --context destination
```

**Why**

We confirmed that both clusters and their managed node groups were
active and that each cluster had a Ready worker node.

The lab used one `t3.large` worker per cluster. We kept the node groups
at one desired node because of the account's available EC2 vCPU
capacity. When deployments could not schedule extra replicas because of
CPU requests, we reduced the application replica count to one instead of
increasing node capacity.

## Step 4 --- Configure EBS CSI driver permissions using Pod Identity

MySQL requires persistent storage. In EKS, the EBS CSI driver provisions
and attaches EBS volumes for PersistentVolumeClaims.

We configured the EBS CSI add-on and IAM roles for each cluster:

-   `source-ebs-csi-role`
-   `destination-ebs-csi-role`

The roles were configured to trust the EKS Pod Identity service
principal:

``` text
pods.eks.amazonaws.com
```

The roles were associated with the EBS CSI controller service account:

``` text
kube-system/ebs-csi-controller-sa
```

The policy attached to the roles was:

``` text
AmazonEBSCSIDriverPolicy
```

The Pod Identity association was created separately for each cluster,
connecting its EBS CSI controller service account to the matching IAM
role.

Check the add-on:

``` bash
aws eks describe-addon \
  --cluster-name source-cluster \
  --addon-name aws-ebs-csi-driver \
  --region ap-south-1

aws eks describe-addon \
  --cluster-name dest-cluster \
  --addon-name aws-ebs-csi-driver \
  --region ap-south-1
```

Check controller pods:

``` bash
kubectl get pods -n kube-system \
  --context source | grep ebs-csi

kubectl get pods -n kube-system \
  --context destination | grep ebs-csi
```

**Why**

A PVC alone cannot create an EBS volume. The CSI controller needs AWS
permissions to provision and manage EBS volumes. Pod Identity provides
those permissions to the controller without placing static AWS
credentials in Kubernetes.

## Step 5 --- Create the gp3 StorageClass on both clusters

We created a StorageClass named `gp3` on both clusters.

Manifest used:

``` yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  fsType: ext4
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
reclaimPolicy: Retain
```

Apply it:

``` bash
kubectl apply -f gp3-storageclass.yaml --context source
kubectl apply -f gp3-storageclass.yaml --context destination
```

Verify:

``` bash
kubectl get storageclass --context source
kubectl get storageclass --context destination
```

**What the settings mean**

-   `provisioner: ebs.csi.aws.com`: uses the AWS EBS CSI driver.
-   `type: gp3`: provisions general-purpose SSD EBS volumes.
-   `fsType: ext4`: formats the volume using ext4.
-   `WaitForFirstConsumer`: delays volume binding/provisioning until a
    pod using the PVC is scheduled. This helps choose a compatible
    Availability Zone.
-   `allowVolumeExpansion: true`: allows supported PVC expansion.
-   `reclaimPolicy: Retain`: retains the underlying volume when the PVC
    is released, rather than automatically deleting it.

**Why**

The database needs storage that survives MySQL pod restarts and
rescheduling. The EBS volume is separate from the MySQL container
lifecycle.

## Step 6 --- Install Istio on both EKS clusters

Istio 1.31.4 was installed on both clusters.

**Important concept: Istio is installed at the Kubernetes cluster level,
not manually installed on every EC2 worker node.**

The Istio installation creates Kubernetes workloads and resources,
including:

-   `istiod`: the Istio control-plane deployment.
-   `istio-ingressgateway`: the ingress gateway deployment and service.
-   CRDs and configuration resources used by Istio.

The control plane and gateway pods are scheduled onto cluster worker
nodes by Kubernetes.

The application data plane is provided by Envoy sidecar containers
injected into eligible application pods. We did not SSH into each node
and install Istio software manually.

The Istio CLI was downloaded and used to install the control plane on
each cluster. The installation command used was:

``` bash
istioctl install --set profile=default -y
```

Run it once while targeting the source kubeconfig context, and once
while targeting the destination context. The CLI's selected Kubernetes
context determines which cluster receives the installation.

Verify the installation:

``` bash
kubectl get pods -n istio-system --context source
kubectl get pods -n istio-system --context destination

kubectl get svc -n istio-system --context source
kubectl get svc -n istio-system --context destination
```

**Why**

Istio provides service-mesh capabilities and ingress traffic management.
Its ingress gateway gives us an entry point to each cluster, while
Gateway and VirtualService resources define how incoming HTTP requests
reach the frontend service.

## Step 7 --- Create the application namespace

The namespace `three-tier` was created independently on both clusters.

Manifest:

``` yaml
apiVersion: v1
kind: Namespace
metadata:
  name: three-tier
  labels:
    istio-injection: enabled
```

Apply:

``` bash
kubectl apply -f kubernetes/namespace.yaml --context source
kubectl apply -f kubernetes/namespace.yaml --context destination
```

Verify:

``` bash
kubectl get namespace three-tier --context source
kubectl get namespace three-tier --context destination
```

**Why**

Kubernetes namespaces provide logical separation for application
resources. The same namespace name on two clusters does not make it a
shared namespace; each cluster has its own independent namespace.

The label `istio-injection: enabled` enables automatic sidecar injection
for newly created eligible pods in that namespace.

## Step 8 --- Create the MySQL credentials Secret

The MySQL manifests use a Kubernetes Secret named `mysql-secret`.

The Secret contains:

-   `mysql-root-password`
-   `mysql-app-password`

It was created independently in the `three-tier` namespace on both
clusters.

A typical command pattern is:

``` bash
kubectl create secret generic mysql-secret \
  -n three-tier \
  --from-literal=mysql-root-password='<ROOT_PASSWORD>' \
  --from-literal=mysql-app-password='<APP_PASSWORD>' \
  --context source

kubectl create secret generic mysql-secret \
  -n three-tier \
  --from-literal=mysql-root-password='<ROOT_PASSWORD>' \
  --from-literal=mysql-app-password='<APP_PASSWORD>' \
  --context destination
```

Use the actual credentials configured in your environment; do not put
real passwords in Git or this README.

Verify that the Secret exists without printing its contents:

``` bash
kubectl get secret mysql-secret -n three-tier --context source
kubectl get secret mysql-secret -n three-tier --context destination
```

**Why**

Secrets keep credentials out of plain application manifests. The MySQL
container and backend Deployment reference these Secret values through
environment variables.

## Step 9 --- Deploy MySQL on the source cluster

We applied:

``` bash
kubectl apply -f kubernetes/mysql.yaml --context source
```

The manifest creates the database-related resources:

-   `mysql-init` ConfigMap for initial database setup.
-   `mysql-headless` service for StatefulSet network identity.
-   `mysql-service` ClusterIP service for application connections.
-   `mysql` StatefulSet.
-   A 10Gi PVC using the `gp3` StorageClass.

Check resources:

``` bash
kubectl get configmap,svc,statefulset,pvc -n three-tier \
  --context source

kubectl get pods -n three-tier -o wide --context source
```

Wait for MySQL to be ready:

``` bash
kubectl get pod mysql-0 -n three-tier --context source
```

The MySQL pod ran with the MySQL container and an Istio sidecar
(`2/2 Running`).

**Why**

A StatefulSet is suitable for a database because it provides stable pod
identity and persistent volume association. The PVC requests storage,
and the EBS CSI driver provisions the backing EBS volume.

## Step 10 --- Deploy the backend on the source cluster

Apply:

``` bash
kubectl apply -f kubernetes/backend.yaml --context source
```

The backend is a Node.js/Express API listening on port `3000`. It
connects to MySQL through:

``` text
mysql-service:3306
```

The backend uses the `mysql-secret` credentials and the `appdb`
database.

Check:

``` bash
kubectl get deployment backend -n three-tier --context source
kubectl get pods -n three-tier --context source -o wide
kubectl get svc backend-service -n three-tier --context source
```

Because the source node had CPU scheduling pressure, we ran one backend
replica:

``` bash
kubectl scale deployment backend \
  --replicas=1 \
  -n three-tier \
  --context source
```

**Why**

The backend provides API endpoints for health checks and user data.
Scaling to one replica kept the lab within the available worker-node
capacity.

## Step 11 --- Deploy the frontend on the source cluster

Apply:

``` bash
kubectl apply -f kubernetes/frontend.yaml --context source
```

The frontend uses React, built into static assets and served by Nginx on
port `80`.

The frontend Nginx configuration proxies API requests to:

``` text
backend-service.three-tier.svc.cluster.local:3000
```

The frontend was configured with one replica and automatic Istio sidecar
injection disabled:

``` yaml
sidecar.istio.io/inject: "false"
```

This was an intentional lab configuration for the frontend. The backend
and MySQL pods were injected and showed two containers.

Check:

``` bash
kubectl get deployment frontend -n three-tier --context source
kubectl get pods -n three-tier --context source -o wide
kubectl get svc frontend-service -n three-tier --context source
```

**Why**

The frontend is the browser-facing application. Nginx serves the React
files and proxies `/api/` requests to the backend service, avoiding the
need for the browser to connect directly to the backend pod.

## Step 12 --- Test the source application internally

We used port-forwarding to test services from the administration host.

Example backend port-forward:

``` bash
kubectl port-forward svc/backend-service 3001:3000 \
  -n three-tier \
  --context source
```

Keep this command running in one terminal. In another terminal, test:

``` bash
curl http://127.0.0.1:3001/api/health
```

Expected response:

``` json
{"status":"ok","database":"connected"}
```

Test users:

``` bash
curl http://127.0.0.1:3001/api/users
```

**Why**

Port-forwarding provides a temporary local tunnel to a Kubernetes
Service. It is useful for troubleshooting without exposing the backend
service publicly.

## Step 13 --- Back up the source MySQL database

We exported the `appdb` database using `mysqldump` from the source MySQL
pod.

The backup was stored on the administration EC2 host:

``` text
migration-backup/appdb-source.sql
```

The general command pattern is:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context source \
  -c mysql -- \
  sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" appdb' \
  > migration-backup/appdb-source.sql
```

Check the backup:

``` bash
ls -lh migration-backup/
head -n 20 migration-backup/appdb-source.sql
```

**What happens here**

-   `kubectl exec` runs a command inside the source MySQL pod.
-   `-c mysql` selects the MySQL container.
-   `mysqldump` exports the database schema and data.
-   `>` redirects the output to a SQL file on the administration EC2
    host.

**Why**

The SQL dump is a portable logical backup. We can transfer and restore
it into a different MySQL instance without copying the source EBS
volume.

## Step 14 --- Deploy MySQL on the destination cluster

Apply the same database manifest to destination:

``` bash
kubectl apply -f kubernetes/mysql.yaml --context destination
```

Check:

``` bash
kubectl get pods,pvc,svc,statefulset -n three-tier \
  --context destination
```

Wait for the destination MySQL pod and PVC to become ready and Bound.

**Why**

The destination needs its own database pod and its own EBS volume. The
source EBS volume is not automatically shared with the destination
cluster.

## Step 15 --- Restore the initial database backup on destination

The initial source backup was imported into the destination database.

General command pattern:

``` bash
kubectl exec -i mysql-0 \
  -n three-tier \
  --context destination \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" appdb' \
  < migration-backup/appdb-source.sql
```

The `<` operator sends the local SQL file into the MySQL command running
in the destination pod.

Verify:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context destination \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D appdb -e "SELECT * FROM users ORDER BY id;"'
```

**Why**

This creates the initial copy of the source database in the destination
cluster. The two databases are independent after restoration; subsequent
writes do not automatically replicate.

## Step 16 --- Deploy backend and frontend on destination

Apply the application manifests:

``` bash
kubectl apply -f kubernetes/backend.yaml --context destination
kubectl apply -f kubernetes/frontend.yaml --context destination
```

Scale the deployments to one replica to fit the destination worker
capacity:

``` bash
kubectl scale deployment backend \
  --replicas=1 \
  -n three-tier \
  --context destination

kubectl scale deployment frontend \
  --replicas=1 \
  -n three-tier \
  --context destination
```

Verify:

``` bash
kubectl get deployments,pods,svc -n three-tier \
  --context destination
```

Check destination backend health using port-forwarding:

``` bash
kubectl port-forward svc/backend-service 3001:3000 \
  -n three-tier \
  --context destination
```

In another terminal:

``` bash
curl http://127.0.0.1:3001/api/health
curl http://127.0.0.1:3001/api/users
```

**Why**

The same application version and Kubernetes resources are deployed in
destination. The backend connects to the destination's local
`mysql-service`, not to the source database.

## Step 17 --- Test the destination frontend

Port-forward the frontend Service:

``` bash
kubectl port-forward svc/frontend-service 8081:80 \
  -n three-tier \
  --context destination
```

In another terminal:

``` bash
curl http://127.0.0.1:8081/
curl http://127.0.0.1:8081/api/
curl http://127.0.0.1:8081/api/users
```

Open this address in a browser on the same machine where the
port-forward is running:

``` text
http://127.0.0.1:8081
```

**Why**

This verifies that the React frontend is served and that its Nginx proxy
can reach the destination backend and database.

## Step 18 --- Configure Istio Gateway and VirtualService

We applied `istio/gateway-virtualservice.yaml` to both clusters.

The manifest creates:

-   `Gateway`: configures the Istio ingress gateway to accept HTTP on
    port `80`.
-   `VirtualService`: routes incoming requests to `frontend-service` on
    port `80`.

Apply:

``` bash
kubectl apply -f istio/gateway-virtualservice.yaml --context source
kubectl apply -f istio/gateway-virtualservice.yaml --context destination
```

Verify:

``` bash
kubectl get gateway,virtualservice -n three-tier --context source
kubectl get gateway,virtualservice -n three-tier --context destination
```

The VirtualService route sends traffic to:

``` text
frontend-service.three-tier.svc.cluster.local:80
```

**Why**

The Istio ingress gateway is the cluster entry point. The Gateway
defines which traffic the gateway accepts, while the VirtualService
defines how that traffic is routed to the application.

## Step 19 --- Access each cluster through its Istio ingress Network Load Balancer

The ingress gateway Service provisions an AWS Network Load Balancer.

Source ingress address:

``` text
a4762ddeb752642ab8dee84f35e2c32c-929152494.ap-south-1.elb.amazonaws.com
```

Destination ingress address:

``` text
a231fc746c8f54e44b1ecc6f3ef79df3-44459895.ap-south-1.elb.amazonaws.com
```

Test the source:

``` bash
curl -i http://a4762ddeb752642ab8dee84f35e2c32c-929152494.ap-south-1.elb.amazonaws.com/
```

Test the destination:

``` bash
curl -i http://a231fc746c8f54e44b1ecc6f3ef79df3-44459895.ap-south-1.elb.amazonaws.com/
```

Open both addresses in a browser to compare the applications.

**Why**

This tests the full ingress path:

``` text
Browser -> AWS NLB -> Istio Ingress Gateway -> VirtualService
         -> frontend-service -> frontend Pod
```

The frontend then sends API requests through its Nginx proxy to the
backend and MySQL.

## Step 20 --- Demonstrate a source-side data change

We updated Alice's email in the source MySQL database:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context source \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D appdb -e "UPDATE users SET email='\''alice.updated@example.com'\'' WHERE id=2;"'
```

Verify source:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context source \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D appdb -e "SELECT * FROM users ORDER BY id;"'
```

Source data after update:

``` text
1  John   john@example.com
2  Alice  alice.updated@example.com
```

Destination still had the old email at this point:

``` text
1  John   john@example.com
2  Alice  alice@example.com
```

**Why**

This deliberately demonstrated that a one-time database dump is not
continuous replication. Changes made to the source after the first dump
do not automatically appear in destination.

## Step 21 --- Create a fresh final source database dump

After the source update, we created a new dump:

``` text
migration-backup/appdb-final-updated-20261111-100301.sql
```

Command:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context source \
  -c mysql -- \
  sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" appdb' \
  > migration-backup/appdb-final-updated-20261111-100301.sql
```

Verify that the new dump contains the updated email:

``` bash
grep -n 'alice.updated@example.com' \
  migration-backup/appdb-final-updated-20261111-100301.sql
```

**Why**

The final dump captures the source database after the demonstration
update. It is the snapshot we use to synchronize destination with the
latest source data.

## Step 22 --- Restore the final dump into destination

We restored the new dump:

``` bash
kubectl exec -i mysql-0 \
  -n three-tier \
  --context destination \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" appdb' \
  < migration-backup/appdb-final-updated-20261111-100301.sql
```

Then verified the destination:

``` bash
kubectl exec mysql-0 \
  -n three-tier \
  --context destination \
  -c mysql -- \
  sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -D appdb -e "SELECT * FROM users ORDER BY id;"'
```

Verified result:

``` text
id  name   email
1   John   john@example.com
2   Alice  alice.updated@example.com
```

**Why**

This completed the final logical database synchronization for our lab.
The destination now contains the updated data from the source snapshot.

> The final SQL dump was restored into the destination database.
> Depending on the dump contents, a restore may drop and recreate
> objects. Do not run this against a production database without a
> reviewed backup, restore plan, and write-coordination procedure.

------------------------------------------------------------------------

# 5. Important concepts learned

  -----------------------------------------------------------------------
  Concept                             What we learned
  ----------------------------------- -----------------------------------
  EKS cluster                         A managed Kubernetes control plane
                                      with worker capacity for pods.

  Node group                          The EC2 worker nodes that run
                                      Kubernetes workloads.

  kubectl context                     Selects which cluster receives a
                                      Kubernetes command.

  Namespace                           Logical grouping of resources
                                      inside one cluster.

  StatefulSet                         Manages stateful workloads such as
                                      MySQL with stable identity.

  PVC                                 A request for persistent storage.

  StorageClass                        Defines how persistent storage is
                                      dynamically provisioned.

  EBS CSI driver                      Connects Kubernetes persistent
                                      storage requests to AWS EBS.

  Pod Identity                        Gives a Kubernetes workload AWS
                                      permissions through an IAM role.

  Secret                              Stores credentials consumed by
                                      Kubernetes workloads.

  ConfigMap                           Supplies non-sensitive
                                      configuration to workloads.

  ClusterIP Service                   Stable internal endpoint for
                                      communication between pods.

  Deployment                          Manages stateless application
                                      replicas such as frontend and
                                      backend.

  Istio control plane                 Configures the service mesh and
                                      Envoy proxies.

  Envoy sidecar                       Data-plane proxy running alongside
                                      an application container.

  Istio Gateway                       Defines ingress listener
                                      configuration.

  VirtualService                      Defines request routing rules.

  NLB                                 AWS load balancer exposing the
                                      Istio ingress gateway.

  mysqldump                           Creates a logical MySQL backup.

  mysql restore                       Imports a SQL dump into another
                                      MySQL instance.

  Port-forward                        Creates a temporary local tunnel to
                                      a Kubernetes resource.
  -----------------------------------------------------------------------

## 6. What is not yet completed

The following is intentionally not marked complete:

### Final traffic cutover

We have not changed a DNS record, application endpoint, or upstream
client configuration to send all users to destination. Both clusters are
currently accessible independently.

A real cutover should include:

1.  Decide and communicate a maintenance or cutover window.
2.  Stop or coordinate writes to the source database.
3.  Take a final consistent source backup, or use a replication
    mechanism if downtime must be minimized.
4.  Restore and validate the final destination database.
5.  Validate destination application health and critical user journeys.
6.  Change DNS, upstream routing, or the client endpoint to destination.
7.  Monitor errors, latency, and application behavior.
8.  Keep source resources available for a defined rollback period.
9.  Decommission source only after business approval and rollback
    expiry.

A DNS change alone does not synchronize databases. If source continues
accepting writes after the final dump, those writes will not
automatically appear in destination.

## 7. Useful troubleshooting commands

Check all resources in the application namespace:

``` bash
kubectl get all -n three-tier --context source
kubectl get all -n three-tier --context destination
```

Check pods and node placement:

``` bash
kubectl get pods -n three-tier -o wide --context source
kubectl get pods -n three-tier -o wide --context destination
```

Check pod details and events:

``` bash
kubectl describe pod <POD_NAME> -n three-tier --context source
kubectl describe pod <POD_NAME> -n three-tier --context destination
```

Check logs:

``` bash
kubectl logs <POD_NAME> -n three-tier --context source
kubectl logs <POD_NAME> -n three-tier --context destination
```

For a pod with multiple containers, specify the container:

``` bash
kubectl logs <POD_NAME> -c <CONTAINER_NAME> \
  -n three-tier --context destination
```

Check PVCs:

``` bash
kubectl get pvc -n three-tier --context source
kubectl get pvc -n three-tier --context destination
```

Check Istio:

``` bash
kubectl get pods -n istio-system --context source
kubectl get pods -n istio-system --context destination

kubectl get gateway,virtualservice -n three-tier --context source
kubectl get gateway,virtualservice -n three-tier --context destination
```

Check services and endpoints:

``` bash
kubectl get svc,endpoints -n three-tier --context source
kubectl get svc,endpoints -n three-tier --context destination
```

## 8. Repository layout

The lab directory was organized as follows:

``` text
eks-istio-namespace/
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── frontend/
│   ├── Dockerfile
│   ├── index.html
│   ├── nginx.conf
│   ├── package.json
│   └── src/
│       ├── main.jsx
│       └── style.css
├── istio/
│   └── gateway-virtualservice.yaml
├── kubernetes/
│   ├── backend.yaml
│   ├── frontend.yaml
│   ├── mysql.yaml
│   └── namespace.yaml
└── migration-backup/
    ├── appdb-source.sql
    └── appdb-final-updated-20261111-100301.sql
```

The `gp3-storageclass.yaml` file was created during storage setup in the
working environment. Keep it in the repository if you want the project
to be reproducible from a clean environment.

## 9. Final verification checklist

-   [x] Both EKS clusters reachable through separate contexts.
-   [x] Worker nodes Ready.
-   [x] EBS CSI driver configured on both clusters.
-   [x] EBS CSI IAM permissions configured through Pod Identity.
-   [x] `gp3` StorageClass available on both clusters.
-   [x] Istio installed on both clusters.
-   [x] `three-tier` namespace created on both clusters.
-   [x] MySQL deployed with persistent storage on both clusters.
-   [x] Source frontend and backend running.
-   [x] Destination frontend and backend running.
-   [x] Source API health check successful.
-   [x] Destination API health check successful.
-   [x] Source application accessible through its Istio ingress NLB.
-   [x] Destination application accessible through its Istio ingress
    NLB.
-   [x] Initial database backup and restore completed.
-   [x] Source-side data update demonstrated.
-   [x] Final database dump created after the update.
-   [x] Destination database restored and updated email verified.
-   [ ] Final user traffic cutover to destination.
-   [ ] Source decommissioning after rollback period and approval.

## 10. Operational and security notes

-   Do not commit real passwords, kubeconfig files, AWS credentials, or
    decoded Kubernetes Secrets to Git.
-   Store database backups securely and encrypt them at rest.
-   The lab uses HTTP on the ingress gateway. For production, configure
    TLS and use HTTPS.
-   Review Network Security Groups, Kubernetes NetworkPolicies, IAM
    permissions, and ingress exposure before production use.
-   A single MySQL instance and one application replica per tier are
    suitable for this constrained lab, not a high-availability
    production design.
-   The SQL dump approach is a snapshot migration, not continuous
    database replication.
-   Plan database consistency, write freeze, rollback, DNS TTL,
    monitoring, and ownership before a production cutover.
-   The password warning printed by the MySQL CLI indicates that passing
    a password through a command-line option can be insecure. For
    production automation, use a safer credential-handling method.

------------------------------------------------------------------------

## Lab conclusion

We successfully built the same three-tier application environment in two
separate EKS clusters, configured Istio ingress on both, migrated MySQL
data using a logical backup and restore, and verified the updated data
in the destination cluster.

This lab demonstrates the major building blocks of an EKS-to-EKS
application and database migration. The destination environment is ready
for a planned traffic cutover, but the cutover itself and source
decommissioning remain separate activities.
