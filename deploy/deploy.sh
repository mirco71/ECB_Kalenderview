#!/bin/bash
# =============================================================
#  ECB Kalenderview — Deploy to vServer
#  Run this from your LOCAL machine to deploy updates.
#
#  Usage:
#    bash deploy/deploy.sh user@your-vserver-ip
#
#  On Windows (Git Bash / WSL):
#    bash deploy/deploy.sh root@123.45.67.89
# =============================================================

set -e

# Configuration
APP_DIR="/opt/ecb-kalender"
CONTAINER_NAME="ecb-kalender"
IMAGE_NAME="ecb-kalender"

# Check arguments
if [ -z "$1" ]; then
  echo "❌ Usage: bash deploy/deploy.sh user@server-ip"
  echo "   Example: bash deploy/deploy.sh root@123.45.67.89"
  exit 1
fi

SERVER="$1"

echo "============================================"
echo "  ECB Kalenderview — Deploying to $SERVER"
echo "============================================"
echo ""

# ============ 1. SYNC FILES ============
echo "📦 Uploading files to server..."
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.env' \
  --exclude 'deploy' \
  --exclude 'tests' \
  --exclude '*.test.js' \
  --exclude 'vitest.config.js' \
  --exclude 'plans' \
  ./ "$SERVER:$APP_DIR/"

echo "✅ Files uploaded"

# ============ 2. BUILD & RESTART ============
echo ""
echo "🐳 Building Docker image and restarting container..."
ssh "$SERVER" << REMOTE
  set -e
  cd $APP_DIR

  # Build new image
  echo "   Building image..."
  docker build -t $IMAGE_NAME . --quiet

  # Stop and remove old container (if exists)
  docker stop $CONTAINER_NAME 2>/dev/null || true
  docker rm $CONTAINER_NAME 2>/dev/null || true

  # Start new container
  echo "   Starting container..."
  docker run -d \
    --name $CONTAINER_NAME \
    --restart unless-stopped \
    -p 3000:3000 \
    --env-file $APP_DIR/.env \
    -v ecb-data:/app/data \
    $IMAGE_NAME

  # Wait for it to be healthy
  sleep 2

  # Check if running
  if docker ps | grep -q $CONTAINER_NAME; then
    echo "   ✅ Container is running"
  else
    echo "   ❌ Container failed to start! Logs:"
    docker logs $CONTAINER_NAME
    exit 1
  fi

  # Cleanup old images
  docker image prune -f --quiet > /dev/null 2>&1
REMOTE

echo ""
echo "============================================"
echo "  ✅ Deployment complete!"
echo "============================================"
echo ""
echo "  Check status:  ssh $SERVER 'docker logs $CONTAINER_NAME'"
echo "  View app:      https://your-domain.de"
echo ""
