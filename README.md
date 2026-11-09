# AWS EKS Three-Tier Application (namespace migration lab)

This bundle contains a small React + Nginx frontend, Node.js + Express backend, and MySQL database for deployment to the `three-tier` namespace on EKS.

## Architecture

- React frontend served by Nginx.
- Nginx proxies `/api/` requests to `backend-service`.
- Node.js backend reads users from MySQL.
- MySQL runs as a StatefulSet with a 10 GiB `gp3` PVC.
- Istio sidecar injection is enabled on the namespace.
- Istio Gateway and VirtualService route ingress traffic to the frontend.

## Important migration workflow

Deploy and validate this application on `source-cluster` first. Later, deploy the same application images/manifests to `destination-cluster` and restore the MySQL dump there. Do not expect the source EBS volume or its PVC to be shared with the destination cluster.

## 1. Build and push images from the admin EC2

Prerequisites: Docker, AWS CLI, permission to create/use ECR repositories, and permission to push images.

```bash
aws sts get-caller-identity
aws ecr describe-repositories --repository-names three-tier-backend --region ap-south-1 >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name three-tier-backend --region ap-south-1
aws ecr describe-repositories --repository-names three-tier-frontend --region ap-south-1 >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name three-tier-frontend --region ap-south-1

aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin 779074487325.dkr.ecr.ap-south-1.amazonaws.com

docker build -t three-tier-backend:v1 ./backend
docker tag three-tier-backend:v1 779074487325.dkr.ecr.ap-south-1.amazonaws.com/three-tier-backend:v1
docker push 779074487325.dkr.ecr.ap-south-1.amazonaws.com/three-tier-backend:v1

docker build -t three-tier-frontend:v1 ./frontend
docker tag three-tier-frontend:v1 779074487325.dkr.ecr.ap-south-1.amazonaws.com/three-tier-frontend:v1
docker push 779074487325.dkr.ecr.ap-south-1.amazonaws.com/three-tier-frontend:v1
```

## 2. Create the database secret

Do not commit the secret to Git. Run this on the admin EC2. Enter strong passwords when prompted.

```bash
read -s -p "MySQL root password: " MYSQL_ROOT_PASSWORD; echo
read -s -p "MySQL app password: " MYSQL_APP_PASSWORD; echo

kubectl create namespace three-tier --context source --dry-run=client -o yaml | kubectl apply -f - --context source
kubectl create secret generic mysql-secret \
  -n three-tier \
  --from-literal=mysql-root-password="$MYSQL_ROOT_PASSWORD" \
  --from-literal=mysql-app-password="$MYSQL_APP_PASSWORD" \
  --context source \
  --dry-run=client -o yaml | kubectl apply -f - --context source

unset MYSQL_ROOT_PASSWORD MYSQL_APP_PASSWORD
```

## 3. Deploy to source cluster first

```bash
kubectl apply -f kubernetes/namespace.yaml --context source
kubectl label namespace three-tier istio-injection=enabled --overwrite --context source
kubectl apply -f kubernetes/mysql.yaml --context source
kubectl rollout status statefulset/mysql -n three-tier --context source --timeout=300s
kubectl apply -f kubernetes/backend.yaml --context source
kubectl apply -f kubernetes/frontend.yaml --context source
kubectl rollout status deployment/backend -n three-tier --context source --timeout=180s
kubectl rollout status deployment/frontend -n three-tier --context source --timeout=180s
```

The `mysql-secret` must exist before the MySQL StatefulSet and backend are created.

## 4. Verify the application on source

```bash
kubectl get pods,pvc,svc -n three-tier --context source
kubectl logs statefulset/mysql -n three-tier --context source --tail=50
kubectl logs deployment/backend -n three-tier --context source --tail=50
kubectl exec deployment/backend -n three-tier --context source -- \
  node -e "fetch('http://localhost:3000/api/users').then(r=>r.text()).then(console.log)"
```

The `mysql-init` ConfigMap in `kubernetes/mysql.yaml` creates the `users` table and inserts John and Alice when MySQL initializes a brand-new data directory. This initialization script runs only on the first initialization of the MySQL PVC. If the PVC already contains a database, MySQL does not rerun it.

## 5. Deploy Istio routing

First verify Istio is installed and the ingress gateway exists:

```bash
kubectl get pods -n istio-system --context source
kubectl get svc -n istio-system istio-ingressgateway --context source
```

Then apply:

```bash
kubectl apply -f istio/gateway-virtualservice.yaml --context source
kubectl get gateway,virtualservice -n three-tier --context source
```

The ingress gateway Service must expose port 80. If the gateway uses an NLB, configure/verify that Service separately according to your cluster's AWS load-balancer permissions and existing setup.

## 6. Access the app for a local test

Port-forward the frontend service:

```bash
kubectl port-forward svc/frontend-service 8080:80 -n three-tier --context source
```

Open `http://localhost:8080` from a browser that can reach the admin EC2's forwarded port, or use `curl http://localhost:8080` on the admin EC2. Keep the port-forward terminal open.

## 7. Database migration to destination (later phase)

For the namespace migration, do not copy the source EBS volume directly to destination. Use a logical MySQL dump/restore:

1. Stop writes or put the application into maintenance mode.
2. Dump the source MySQL database.
3. Create `mysql-secret` in destination using the same app credentials.
4. Deploy MySQL on destination, which provisions a separate destination gp3 PVC.
5. Restore the dump into destination MySQL.
6. Deploy backend/frontend and Istio resources to destination.
7. Validate and cut over traffic.

We will perform these steps only after the source deployment is healthy.

## Resource sizing note

The manifests use modest resource requests, but the clusters currently have one worker each. If pods remain Pending, inspect `kubectl describe pod` and node allocatable capacity before increasing replicas or requests.
