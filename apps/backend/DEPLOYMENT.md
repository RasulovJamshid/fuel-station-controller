# AZS Manager — Remote Server Deployment Guide

This guide takes you from a blank Ubuntu/Debian VPS to a running production backend in about 30 minutes.

---

## Table of Contents

1. [Server requirements](#1-server-requirements)
2. [Initial server setup](#2-initial-server-setup)
3. [Install Docker and Docker Compose](#3-install-docker-and-docker-compose)
4. [Upload the application](#4-upload-the-application)
5. [Configure environment variables](#5-configure-environment-variables)
6. [Configure nginx for your domain](#6-configure-nginx-for-your-domain)
7. [Obtain a TLS certificate](#7-obtain-a-tls-certificate)
8. [First start](#8-first-start)
9. [Verify everything is running](#9-verify-everything-is-running)
10. [Day-to-day operations](#10-day-to-day-operations)
11. [Updating the application](#11-updating-the-application)
12. [Backup and restore](#12-backup-and-restore)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Server requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB SSD | 60 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 22.04 LTS |
| Open ports | 22 (SSH), 80, 443 | same |

Providers that work well: Hetzner Cloud (CX21+), DigitalOcean (Droplet 2 GB+), Vultr, or any VPS with a public IP.

---

## 2. Initial server setup

Connect as root, then run:

```bash
# Create a deployment user (never run production as root)
adduser deploy
usermod -aG sudo deploy
# Copy your SSH key to the new user
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Basic firewall — allow SSH, HTTP, HTTPS only
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# Keep the system patched
apt update && apt upgrade -y
apt install -y curl git unzip ca-certificates gnupg lsb-release

# Switch to the deployment user for all further steps
su - deploy
```

---

## 3. Install Docker and Docker Compose

```bash
# Add Docker's official GPG key and repository
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

# Allow the deploy user to run docker without sudo
sudo usermod -aG docker deploy
newgrp docker   # apply group without logout

# Verify
docker --version          # Docker 25+
docker compose version    # Docker Compose v2.x
```

---

## 4. Upload the application

**Option A — Git (recommended if you have a private repo)**

```bash
# On the server
git clone https://github.com/your-org/fuel-dispenser.git /opt/azs
cd /opt/azs/apps/backend
```

**Option B — rsync from your local machine**

```bash
# Run this from your local machine
rsync -avz --exclude node_modules --exclude dist --exclude .git \
  ./apps/backend/ deploy@YOUR_SERVER_IP:/opt/azs/backend/
```

Then on the server:

```bash
cd /opt/azs/backend
```

All remaining commands in this guide assume you are inside the `apps/backend/` directory.

---

## 5. Configure environment variables

```bash
# Start from the example file
cp .env.example .env
nano .env   # or use vim
```

### Generate strong secrets

Run this command **three times** to get three independent secrets (JWT_SECRET, JWT_REFRESH_SECRET, and one for POSTGRES_PASSWORD / REDIS_PASSWORD):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Required values to change

Open `.env` and set every line that says `CHANGE_ME`:

```env
# Database
POSTGRES_PASSWORD=<strong-random-password>
DATABASE_URL=postgresql://azs:<strong-random-password>@postgres:5432/azs_manager?connection_limit=10&pool_timeout=30

# Redis — password must be identical in both lines
REDIS_PASSWORD=<strong-random-password>
REDIS_URL=redis://:<strong-random-password>@redis:6379

# JWT — use two different secrets
JWT_SECRET=<64-char-hex>
JWT_REFRESH_SECRET=<64-char-hex-different>

# Your domain(s)
CORS_ORIGINS=https://azs.yourdomain.com

# First admin account (used only on the very first start)
SEED_ADMIN_EMAIL=admin@yourdomain.com
SEED_ADMIN_PASSWORD=<strong-password>
```

### Lock down the file

```bash
chmod 600 .env
```

---

## 6. Configure nginx for your domain

Edit `nginx.conf` and replace `server_name _;` with your actual domain:

```bash
sed -i 's/server_name _;/server_name azs.yourdomain.com;/' nginx.conf
```

At this point, keep the server listening on **port 80** (HTTP only). You will switch to HTTPS after obtaining the TLS certificate in the next step.

---

## 7. Obtain a TLS certificate

We use Certbot with the standalone plugin so the certificate is fetched before nginx is running.

```bash
# Install Certbot
sudo apt install -y certbot

# Stop anything using port 80 first (nothing should be yet)
# Request the certificate
sudo certbot certonly --standalone \
  -d azs.yourdomain.com \
  --non-interactive \
  --agree-tos \
  --email admin@yourdomain.com

# Certificates are written to:
#   /etc/letsencrypt/live/azs.yourdomain.com/fullchain.pem
#   /etc/letsencrypt/live/azs.yourdomain.com/privkey.pem

# Make them readable by the deploy user's docker group
sudo chmod 755 /etc/letsencrypt/live/
sudo chmod 755 /etc/letsencrypt/archive/
```

### Create the ssl/ directory and link the certs

```bash
mkdir -p ssl
sudo cp /etc/letsencrypt/live/azs.yourdomain.com/fullchain.pem ssl/fullchain.pem
sudo cp /etc/letsencrypt/live/azs.yourdomain.com/privkey.pem   ssl/privkey.pem
sudo chown deploy:deploy ssl/*.pem
chmod 600 ssl/privkey.pem
```

### Enable HTTPS in nginx.conf

Open `nginx.conf` and make these changes:

1. **Uncomment** the HTTP → HTTPS redirect block at the top of the `http {}` section:
   ```nginx
   server {
       listen 80;
       server_name azs.yourdomain.com;
       return 301 https://$host$request_uri;
   }
   ```

2. **Change** the main server block to listen on 443:
   ```nginx
   listen 443 ssl http2;
   server_name azs.yourdomain.com;
   ```

3. **Uncomment** the SSL lines inside the server block:
   ```nginx
   ssl_certificate     /etc/nginx/ssl/fullchain.pem;
   ssl_certificate_key /etc/nginx/ssl/privkey.pem;
   ssl_protocols       TLSv1.2 TLSv1.3;
   ...
   add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
   ```

### Auto-renew certificate

```bash
# Certbot installs a systemd timer automatically. Verify it:
sudo systemctl status certbot.timer

# Add a deploy hook to copy renewed certs and reload nginx
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/azs.sh <<'EOF'
#!/bin/sh
cp /etc/letsencrypt/live/azs.yourdomain.com/fullchain.pem /opt/azs/backend/ssl/fullchain.pem
cp /etc/letsencrypt/live/azs.yourdomain.com/privkey.pem   /opt/azs/backend/ssl/privkey.pem
chmod 600 /opt/azs/backend/ssl/privkey.pem
docker exec $(docker ps -qf name=azs_nginx) nginx -s reload
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/azs.sh
```

---

## 8. First start

```bash
cd /opt/azs/backend

# Build images and start all services in the background
docker compose up -d --build

# Watch the startup logs (Ctrl-C to stop watching — services keep running)
docker compose logs -f
```

**Expected startup order:**

1. `postgres` — TimescaleDB starts, health check passes (~10 s)
2. `redis` — starts in ~2 s
3. `backend` — waits for postgres, runs `prisma db push`, seeds admin user, starts NestJS (~30 s)
4. `nginx` — proxies requests once backend is healthy

The first build downloads base images and compiles TypeScript — it takes **2–4 minutes**. Subsequent builds are much faster due to Docker layer caching.

---

## 9. Verify everything is running

### Check container status

```bash
docker compose ps
```

All four services should show `healthy` or `running`:

```
NAME              STATUS
azs_nginx         running (healthy)
azs_backend       running (healthy)
azs_postgres      running (healthy)
azs_redis         running (healthy)
```

### Health check

```bash
curl -s https://azs.yourdomain.com/api/health | python3 -m json.tool
```

Expected response:

```json
{
  "status": "ok",
  "info": { "database": { "status": "up" } }
}
```

### Test login

```bash
curl -s -X POST https://azs.yourdomain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@yourdomain.com","password":"YOUR_SEED_PASSWORD"}' \
  | python3 -m json.tool
```

You should receive an `accessToken` in the response.

### Verify TLS rating (optional)

Visit `https://www.ssllabs.com/ssltest/analyze.html?d=azs.yourdomain.com` — you should get **A** or **A+**.

---

## 10. Day-to-day operations

### View logs

```bash
# All services, live
docker compose logs -f

# One service only
docker compose logs -f backend
docker compose logs -f nginx

# Last 100 lines of backend
docker compose logs --tail=100 backend
```

### Restart a service

```bash
docker compose restart backend
docker compose restart nginx
```

### Stop everything

```bash
docker compose down
```

### Start everything

```bash
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

### Run a one-off backend command

```bash
# Prisma Studio (web UI for the database) — bind to localhost only
docker compose exec backend npx prisma studio --port 5555
# Then ssh-tunnel: ssh -L 5555:localhost:5555 deploy@YOUR_SERVER_IP
```

---

## 11. Updating the application

```bash
cd /opt/azs/backend

# Pull latest code (if using git)
git -C /opt/azs pull

# Rebuild and restart with zero downtime for nginx/redis/postgres
docker compose up -d --build backend

# Watch the rolling restart
docker compose logs -f backend
```

The `postgres` and `redis` containers are untouched during application updates — no data is lost.

If the Prisma schema changed, `entrypoint.sh` runs `prisma db push` automatically on startup, applying new tables/columns without dropping existing data.

---

## 12. Backup and restore

### Manual database backup

```bash
# Creates a compressed SQL dump in ./backups/
docker compose exec postgres \
  pg_dump -U azs azs_manager \
  | gzip > backups/azs_$(date +%Y%m%d_%H%M%S).sql.gz

# List backups
ls -lh backups/
```

### Automated daily backup (cron)

Add to the `deploy` user's crontab (`crontab -e`):

```cron
0 2 * * * cd /opt/azs/backend && docker compose exec -T postgres \
  pg_dump -U azs azs_manager | gzip \
  > backups/azs_$(date +\%Y\%m\%d).sql.gz 2>> /var/log/azs-backup.log
```

### Restore from backup

```bash
# Stop the backend so no writes happen during restore
docker compose stop backend

# Restore
gunzip -c backups/azs_20240601_020000.sql.gz \
  | docker compose exec -T postgres psql -U azs -d azs_manager

# Restart
docker compose start backend
```

---

## 13. Troubleshooting

### Backend won't start

```bash
docker compose logs backend | tail -50
```

Common causes:
- **`DATABASE_URL` wrong** — check that the password matches `POSTGRES_PASSWORD`
- **`REDIS_URL` wrong** — check that the password matches `REDIS_PASSWORD`
- **`JWT_SECRET` too short** — must be at least 32 characters
- **Port 4000 already in use** — check with `ss -tlnp | grep 4000`

### nginx returns 502 Bad Gateway

The backend container is not ready yet. Wait 30 seconds and try again.

```bash
# Check if backend is healthy
docker compose ps backend
docker compose logs backend | grep "running on port"
```

### Cannot connect to WebSocket

1. Confirm the `CORS_ORIGINS` in `.env` includes the exact origin the browser is using (including `https://` and no trailing slash).
2. Confirm nginx config has the `/dashboard` location block with `proxy_set_header Upgrade $http_upgrade;`.
3. Check browser developer tools → Network → WS tab for the connection error.

### Database connection pool exhausted

Increase `connection_limit` in `DATABASE_URL`:

```env
DATABASE_URL=postgresql://azs:pass@postgres:5432/azs_manager?connection_limit=20&pool_timeout=30
```

Also check for queries taking unusually long:

```bash
docker compose exec postgres psql -U azs -d azs_manager \
  -c "SELECT pid, now() - pg_stat_activity.query_start AS duration, query
      FROM pg_stat_activity
      WHERE state = 'active' AND now() - query_start > interval '5 seconds'
      ORDER BY duration DESC;"
```

### TLS certificate expired

```bash
sudo certbot renew --dry-run   # test first
sudo certbot renew             # renew
```

The deploy hook copies the new cert and reloads nginx automatically.

### Check disk space

```bash
df -h
docker system df          # see Docker space usage
docker system prune -f    # remove unused images/containers (safe; data volumes are untouched)
```

---

## Quick-reference cheatsheet

```bash
# Start
docker compose up -d --build

# Stop
docker compose down

# Restart app only
docker compose restart backend

# Live logs
docker compose logs -f

# Health check
curl https://azs.yourdomain.com/api/health

# Database shell
docker compose exec postgres psql -U azs -d azs_manager

# Manual backup
docker compose exec -T postgres pg_dump -U azs azs_manager | gzip > backups/manual.sql.gz

# Renew TLS
sudo certbot renew

# Pull + redeploy
git -C /opt/azs pull && docker compose up -d --build backend
```
