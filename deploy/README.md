> Testest du erst per Portainer-Stack auf einer Synology DiskStation? Siehe
> [portainer-synology.md](portainer-synology.md) für diesen Weg — dieses
> Dokument beschreibt die klassische SSH/Nginx-Variante für einen vServer.

# Deployment Guide — Dogado vServer

## Prerequisites

- Dogado vServer with SSH access (root)
- A domain with DNS pointing to your vServer IP
- Git Bash or WSL on your Windows machine (for running bash scripts)

## First-Time Setup

### 1. Point your DNS

In your Dogado DNS settings, add an **A record**:
```
kalender.your-domain.de  →  your-vserver-ip-address
```

Wait for DNS propagation (can take a few minutes to hours).

### 2. Upload the setup script to your server

```bash
scp deploy/server-setup.sh root@YOUR_SERVER_IP:/root/server-setup.sh
```

### 3. Run the setup script on the server

```bash
ssh root@YOUR_SERVER_IP
bash /root/server-setup.sh
```

This will:
- Install Docker, Nginx, and Certbot
- Create the app directory at `/opt/ecb-kalender`
- Generate a secure JWT secret
- Configure Nginx as a reverse proxy
- Set up daily database backups
- Optionally install an SSL certificate

### 4. Deploy the application

From your local machine (in the project root):

```bash
bash deploy/deploy.sh root@YOUR_SERVER_IP
```

## Updating

Whenever you make changes, just run:

```bash
bash deploy/deploy.sh root@YOUR_SERVER_IP
```

This uploads the code, rebuilds the Docker image, and restarts the container.
Your database is preserved in a Docker volume.

## Useful Commands

```bash
# View container logs
ssh root@YOUR_SERVER_IP 'docker logs ecb-kalender'

# Follow logs in real-time
ssh root@YOUR_SERVER_IP 'docker logs -f ecb-kalender'

# Restart the container
ssh root@YOUR_SERVER_IP 'docker restart ecb-kalender'

# Check container status
ssh root@YOUR_SERVER_IP 'docker ps'

# Manual database backup
ssh root@YOUR_SERVER_IP 'docker cp ecb-kalender:/app/data/calendar.db /root/backups/calendar-manual.db'

# Restore a backup
ssh root@YOUR_SERVER_IP 'docker cp /root/backups/calendar-20260407.db ecb-kalender:/app/data/calendar.db && docker restart ecb-kalender'

# Renew SSL certificate (auto-renews, but manual if needed)
ssh root@YOUR_SERVER_IP 'certbot renew'
```

## Architecture

```
Internet → Nginx (:443 HTTPS) → Docker Container (:3000) → SQLite
                                  ↑
                              Docker Volume (persistent data)
```

## Files

| File | Purpose |
|------|---------|
| `deploy/server-setup.sh` | One-time server setup (run on server) |
| `deploy/deploy.sh` | Deploy updates (run locally) |
| `Dockerfile` | Docker image definition |
| `.env.example` | Environment variable template |
