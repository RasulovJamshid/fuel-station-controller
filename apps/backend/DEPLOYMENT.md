# AZS Manager — Production Deployment Guide

Domain: **fuelstation.ung.uz**
Stack: Next.js frontend · NestJS backend · PostgreSQL (TimescaleDB) · Redis · nginx

---

## Table of Contents

1. [Server requirements](#1-server-requirements)
2. [Initial server setup](#2-initial-server-setup)
3. [Install Docker and Docker Compose](#3-install-docker-and-docker-compose)
4. [Upload the application](#4-upload-the-application)
5. [Configure environment variables](#5-configure-environment-variables)
6. [Obtain a TLS certificate](#6-obtain-a-tls-certificate)
7. [First start](#7-first-start)
8. [Verify everything is running](#8-verify-everything-is-running)
9. [Continuous deployment (GitHub Actions)](#9-continuous-deployment-github-actions)
10. [Day-to-day operations](#10-day-to-day-operations)
11. [Updating the application](#11-updating-the-application)
12. [Backup and restore](#12-backup-and-restore)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Server requirements

| Resource   | Minimum         | Recommended      |
|------------|-----------------|------------------|
| CPU        | 2 vCPU          | 4 vCPU           |
| RAM        | 4 GB            | 8 GB             |
| Disk       | 30 GB SSD       | 60 GB SSD        |
| OS         | Ubuntu 22.04 LTS| Ubuntu 22.04 LTS |
| Open ports | 22, 80, 443     | same             |

Providers: Hetzner Cloud (CX21+), DigitalOcean (Droplet 4 GB+), Vultr.

---

## 2. Initial server setup

Connect as root, then run:

```bash
# Create a non-root deployment user
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Firewall — SSH, HTTP, HTTPS only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Update packages
apt update && apt upgrade -y
apt install -y curl git unzip ca-certificates gnupg lsb-release

# Switch to deploy user for all further steps
su - deploy
```

---

## 3. Install Docker and Docker Compose

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

sudo usermod -aG docker deploy
newgrp docker

# Verify
docker --version           # Docker 25+
docker compose version     # Docker Compose v2.x
```

---

## 4. Upload the application

The compose file lives in `apps/backend/` and references the frontend at `../web`, so the entire monorepo must be present on the server.

### Option A — Git (recommended)

```bash
git clone https://github.com/your-org/fuel-dispenser.git /opt/azs
cd /opt/azs/apps/backend
```

### Option B — rsync from your local machine

Run this from **your local machine** inside the monorepo root:

```bash
rsync -avz \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude '.git' \
  --exclude 'target' \
  ./ deploy@YOUR_SERVER_IP:/opt/azs/
```

Then on the server:

```bash
cd /opt/azs/apps/backend
```

> All remaining commands assume you are inside `apps/backend/`.

### Directory structure on the server

```
/opt/azs/
├── apps/
│   ├── backend/          ← docker-compose.yml lives here
│   │   ├── docker-compose.yml
│   │   ├── Dockerfile
│   │   ├── nginx.conf
│   │   ├── .env          ← created in step 5
│   │   ├── ssl/          ← TLS certs (created in step 6)
│   │   └── backups/
│   └── web/              ← Next.js frontend
│       └── Dockerfile
└── ...
```

---

## 5. Configure environment variables

```bash
cp .env.example .env
nano .env
```

### Generate strong secrets

Run three times to get three independent random values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Required values

```env
# ── Database ─────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=<strong-random-password>
DATABASE_URL=postgresql://azs:<strong-random-password>@postgres:5432/azs_manager?connection_limit=10&pool_timeout=30

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_PASSWORD=<strong-random-password>
REDIS_URL=redis://:<strong-random-password>@redis:6379

# ── JWT ───────────────────────────────────────────────────────────────────────
JWT_SECRET=<64-char-hex>
JWT_REFRESH_SECRET=<64-char-hex-different>

# ── CORS ──────────────────────────────────────────────────────────────────────
CORS_ORIGINS=https://fuelstation.ung.uz

# ── Seed admin (first start only) ────────────────────────────────────────────
SEED_ADMIN_EMAIL=admin@fuelstation.ung.uz
SEED_ADMIN_PASSWORD=<strong-password>
```

```bash
chmod 600 .env
```

---

## 6. Install the corporate TLS certificate

nginx expects exactly two files inside `apps/backend/ssl/`:

| File | Contents |
|------|----------|
| `ssl/fullchain.pem` | Your domain certificate **followed by** the full CA intermediate chain, concatenated in order |
| `ssl/privkey.pem` | The private key (never commit this file — it is in `.gitignore`) |

The `ssl/` directory already exists in the repo (it contains only a `.gitkeep`). Copy your certificate files into it on the server after cloning.

---

### Format A — You received separate `.crt` / `.key` / `.ca-bundle` files

This is the most common corporate delivery format:

```bash
cd /opt/azs/apps/backend/ssl

# Concatenate: domain cert first, then the intermediate chain
cat fuelstation_ung_uz.crt ca-bundle.crt > fullchain.pem

# Copy the private key
cp fuelstation_ung_uz.key privkey.pem

chmod 600 privkey.pem
```

> If your CA gave you multiple intermediate files (e.g. `intermediate1.crt` and `root.crt`), chain them in order: `cat domain.crt intermediate1.crt root.crt > fullchain.pem`

---

### Format B — You received a `.pfx` or `.p12` bundle (common from Windows-based CAs)

```bash
cd /opt/azs/apps/backend/ssl

# Install openssl if needed
sudo apt install -y openssl

# Replace YOUR_PFX_PASSWORD with the password the CA gave you
# (leave it empty and just press Enter if there is no password)

# Extract the domain certificate
openssl pkcs12 -in certificate.pfx -clcerts -nokeys -out domain.crt \
  -passin pass:YOUR_PFX_PASSWORD

# Extract the CA chain
openssl pkcs12 -in certificate.pfx -cacerts -nokeys -chain -out chain.crt \
  -passin pass:YOUR_PFX_PASSWORD

# Extract the private key (no passphrase on the output key)
openssl pkcs12 -in certificate.pfx -nocerts -nodes -out privkey.pem \
  -passin pass:YOUR_PFX_PASSWORD

# Combine cert + chain into fullchain.pem
cat domain.crt chain.crt > fullchain.pem

# Remove the intermediate files
rm domain.crt chain.crt

chmod 600 privkey.pem
```

---

### Format C — You received a single `.pem` that already contains everything

Some CAs deliver a single file that already contains the cert and full chain:

```bash
cd /opt/azs/apps/backend/ssl
cp everything.pem fullchain.pem
cp private.key    privkey.pem
chmod 600 privkey.pem
```

Verify it looks correct (should show at least 2 `CERTIFICATE` blocks):

```bash
grep -c "BEGIN CERTIFICATE" fullchain.pem
# Expected: 2 or 3
```

---

### Verify the certificate before starting

```bash
# Check the cert matches the private key (both MD5 hashes must be identical)
openssl x509 -noout -modulus -in ssl/fullchain.pem | md5sum
openssl rsa  -noout -modulus -in ssl/privkey.pem   | md5sum

# Check the cert is valid for your domain
openssl x509 -noout -subject -issuer -dates -in ssl/fullchain.pem

# Expected output includes:
#   subject= ... fuelstation.ung.uz
#   notAfter= <future date>
```

If the two MD5 hashes differ, the key does not match the certificate — contact your CA.

---

### Certificate renewal

Corporate certificates typically expire after 1 or 2 years. When you receive a renewed certificate, repeat the steps above to replace the files, then reload nginx — **no restart needed**:

```bash
docker compose exec nginx nginx -s reload
```

---

## 7. First start

```bash
cd /opt/azs/apps/backend

# Build all images and start every service
docker compose up -d --build

# Watch startup logs
docker compose logs -f
```

**Expected startup order:**

| # | Service    | What happens                                              | Time     |
|---|------------|-----------------------------------------------------------|----------|
| 1 | `postgres`  | TimescaleDB init, health check passes                    | ~10 s    |
| 2 | `redis`     | Starts with password                                     | ~2 s     |
| 3 | `backend`   | Waits for postgres, runs `prisma db push`, seeds admin   | ~30 s    |
| 4 | `frontend`  | Next.js standalone server starts                         | ~20 s    |
| 5 | `nginx`     | Starts after backend and frontend are healthy            | ~2 s     |

The first build pulls base images and compiles TypeScript + Next.js — allow **3–6 minutes**.

---

## 8. Verify everything is running

```bash
docker compose ps
```

Expected output:

```
NAME                STATUS
azs_nginx           running (healthy)
azs_frontend        running (healthy)
azs_backend         running (healthy)
azs_postgres        running (healthy)
azs_redis           running (healthy)
```

### API health check

```bash
curl -s https://fuelstation.ung.uz/api/health | python3 -m json.tool
```

```json
{ "status": "ok", "info": { "database": { "status": "up" } } }
```

### Frontend

Open `https://fuelstation.ung.uz` in a browser — you should see the login page.

### Test login via API

```bash
curl -s -X POST https://fuelstation.ung.uz/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@fuelstation.ung.uz","password":"YOUR_SEED_PASSWORD"}' \
  | python3 -m json.tool
```

You should receive an `accessToken`.

### TLS rating (optional)

Visit `https://www.ssllabs.com/ssltest/analyze.html?d=fuelstation.ung.uz` — expect **A** or **A+**.

---

## 9. Continuous deployment (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` automatically deploys to the server on every push to `main` that touches `apps/backend/**` or `apps/web/**`. It detects which services changed and rebuilds only those — postgres and redis are never restarted.

### How it works

```
push to main
    │
    ├─ apps/backend/** changed? → rebuild backend
    ├─ apps/web/**     changed? → rebuild frontend
    └─ neither changed          → skip deploy
```

After rebuilding, the workflow waits for all containers to report `healthy`, then hits `/api/health`. If anything fails it posts a Telegram message and marks the run red.

You can also trigger a deploy manually from the GitHub UI (Actions → Deploy to Production → Run workflow) and optionally specify which services to rebuild.

### 1 — Create a deploy SSH key

Run this **on the server** as the `deploy` user:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_deploy -N ""
# Authorise the key for login
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
# Print the private key — you will paste this into GitHub
cat ~/.ssh/github_deploy
```

### 2 — Add GitHub repository secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name          | Value                                      |
|----------------------|--------------------------------------------|
| `DEPLOY_HOST`        | Your server IP or hostname                 |
| `DEPLOY_USER`        | `deploy`                                   |
| `DEPLOY_SSH_KEY`     | Contents of `~/.ssh/github_deploy` (private key) |
| `DEPLOY_PORT`        | `22` (or your custom SSH port)             |
| `TELEGRAM_BOT_TOKEN` | Your bot token (optional — failure alerts) |
| `TELEGRAM_CHAT_ID`   | Chat/group ID to receive alerts (optional) |

### 3 — Allow deploy user to run git pull without a passphrase

The server must be able to pull from the private GitHub repo. The simplest way is a **deploy key**:

```bash
# On the server — generate a separate read-only deploy key for git
ssh-keygen -t ed25519 -C "server-git-pull" -f ~/.ssh/git_deploy -N ""
cat ~/.ssh/git_deploy.pub
```

Add the public key to GitHub: **repo → Settings → Deploy keys → Add deploy key** (read-only, no write access).

Then configure git on the server to use it:

```bash
# ~/.ssh/config
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/git_deploy
  StrictHostKeyChecking accept-new
EOF
chmod 600 ~/.ssh/config

# Test
ssh -T git@github.com
```

Finally, make sure the repo was cloned via SSH (not HTTPS):

```bash
cd /opt/azs
git remote set-url origin git@github.com:your-org/fuel-dispenser.git
```

### 4 — Verify the first automated deploy

Push any change to `main` that touches `apps/backend/` or `apps/web/`, then watch:

```
GitHub → Actions → Deploy to Production → latest run
```

The run should complete in 3–6 minutes on a cold cache. Subsequent deploys are faster due to Docker layer caching.

---

## 10. Day-to-day operations

### View logs

```bash
docker compose logs -f                      # all services, live
docker compose logs -f backend              # backend only
docker compose logs -f frontend             # frontend only
docker compose logs --tail=100 backend      # last 100 lines
```

### Restart a service

```bash
docker compose restart backend
docker compose restart frontend
docker compose restart nginx
```

### Stop / start everything

```bash
docker compose down
docker compose up -d
```

### Open a database shell

```bash
docker compose exec postgres psql -U azs -d azs_manager
```

### Open a Redis shell

```bash
docker compose exec redis redis-cli -a "$REDIS_PASSWORD"
```

### Prisma Studio (web DB UI)

```bash
docker compose exec backend npx prisma studio --port 5555
# SSH tunnel from your machine:
ssh -L 5555:localhost:5555 deploy@YOUR_SERVER_IP
# Then open http://localhost:5555
```

---

## 11. Updating the application

### Backend only

```bash
cd /opt/azs/apps/backend
git -C /opt/azs pull
docker compose up -d --build backend
docker compose logs -f backend
```

### Frontend only

```bash
cd /opt/azs/apps/backend
git -C /opt/azs pull
docker compose up -d --build frontend
docker compose logs -f frontend
```

### Full stack

```bash
cd /opt/azs/apps/backend
git -C /opt/azs pull
docker compose up -d --build
```

`postgres` and `redis` are untouched — no data is lost. Prisma migrations run automatically on backend startup.

---

## 12. Backup and restore

### Manual backup

```bash
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U azs azs_manager \
  | gzip > backups/azs_$(date +%Y%m%d_%H%M%S).sql.gz
```

### Automated daily backup (cron)

```bash
crontab -e
```

Add:

```cron
0 2 * * * cd /opt/azs/apps/backend && docker compose exec -T postgres \
  pg_dump -U azs azs_manager | gzip \
  > backups/azs_$(date +\%Y\%m\%d).sql.gz 2>> /var/log/azs-backup.log
```

### Restore

```bash
docker compose stop backend frontend
gunzip -c backups/azs_20240601_020000.sql.gz \
  | docker compose exec -T postgres psql -U azs -d azs_manager
docker compose start backend frontend
```

---

## 13. Troubleshooting

### Backend won't start

```bash
docker compose logs backend | tail -50
```

Common causes:
- `DATABASE_URL` password doesn't match `POSTGRES_PASSWORD`
- `REDIS_URL` password doesn't match `REDIS_PASSWORD`
- `JWT_SECRET` shorter than 32 characters
- Port 4000 in use: `ss -tlnp | grep 4000`

### Frontend won't start

```bash
docker compose logs frontend | tail -50
```

- `NEXT_PUBLIC_API_URL` not set → API calls will fail at runtime
- Missing `public/` directory in the build context

### nginx 502 Bad Gateway

Backend or frontend isn't ready yet. Wait 30 s and check:

```bash
docker compose ps
docker compose logs backend | grep "running on port"
docker compose logs frontend | grep "ready"
```

### WebSocket not connecting

1. `CORS_ORIGINS` in `.env` must be exactly `https://fuelstation.ung.uz` (no trailing slash).
2. nginx `/dashboard` block must have `proxy_set_header Upgrade $http_upgrade;`.
3. Browser DevTools → Network → WS tab for the error.

### Database connection pool exhausted

```env
DATABASE_URL=postgresql://azs:pass@postgres:5432/azs_manager?connection_limit=20&pool_timeout=30
```

### TLS certificate expired

```bash
sudo certbot renew --dry-run
sudo certbot renew
```

### Disk space

```bash
df -h
docker system df
docker system prune -f    # removes unused images/containers; volumes are safe
```

---

## Quick-reference cheatsheet

```bash
# ── Start / stop ────────────────────────────────────────────────────────────
docker compose up -d --build     # build + start all
docker compose down              # stop all (data volumes preserved)

# ── Restart individual services ──────────────────────────────────────────────
docker compose restart backend
docker compose restart frontend
docker compose restart nginx

# ── Logs ─────────────────────────────────────────────────────────────────────
docker compose logs -f
docker compose logs -f backend
docker compose logs -f frontend

# ── Health ────────────────────────────────────────────────────────────────────
curl https://fuelstation.ung.uz/api/health

# ── Database ──────────────────────────────────────────────────────────────────
docker compose exec postgres psql -U azs -d azs_manager

# ── Backup ────────────────────────────────────────────────────────────────────
docker compose exec -T postgres pg_dump -U azs azs_manager | gzip > backups/manual.sql.gz

# ── Deploy update ─────────────────────────────────────────────────────────────
git -C /opt/azs pull && docker compose up -d --build

# ── Renew TLS ─────────────────────────────────────────────────────────────────
sudo certbot renew
```
