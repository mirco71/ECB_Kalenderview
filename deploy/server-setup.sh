#!/bin/bash
# =============================================================
#  ECB Kalenderview — One-time vServer setup
#  Run this ONCE on your Dogado vServer as root.
#
#  Usage:
#    ssh root@your-vserver-ip
#    bash server-setup.sh
# =============================================================

set -e

APP_DIR="/opt/ecb-kalender"
DOMAIN=""

echo "============================================"
echo "  ECB Kalenderview — Server Setup"
echo "============================================"
echo ""

# Ask for domain
read -p "Domain name (e.g. kalender.ecb-solingen.de): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "❌ Domain is required!"
  exit 1
fi

echo ""
echo "📋 Setting up for domain: $DOMAIN"
echo ""

# ============ 1. INSTALL DOCKER ============
echo "🐳 Installing Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "✅ Docker installed"
else
  echo "✅ Docker already installed"
fi

# ============ 2. INSTALL NGINX + CERTBOT ============
echo ""
echo "🌐 Installing Nginx and Certbot..."
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx > /dev/null
systemctl enable nginx
echo "✅ Nginx and Certbot installed"

# ============ 3. CREATE APP DIRECTORY ============
echo ""
echo "📁 Creating application directory..."
mkdir -p "$APP_DIR"
mkdir -p /root/backups
echo "✅ Directory created: $APP_DIR"

# ============ 4. GENERATE JWT SECRET ============
JWT_SECRET=$(openssl rand -hex 32)

# ============ 5. CREATE .ENV FILE ============
echo ""
echo "⚙️  Creating .env file..."
cat > "$APP_DIR/.env" << EOF
NODE_ENV=production
PORT=3000
JWT_SECRET=$JWT_SECRET
DB_PATH=/app/data/calendar.db
CALENDAR_NAME=Eisbelegung Eissporthalle Solingen
START_HOUR=6
END_HOUR=23
EOF
chmod 600 "$APP_DIR/.env"
echo "✅ .env file created with secure JWT secret"

# ============ 6. CONFIGURE NGINX ============
echo ""
echo "🔧 Configuring Nginx..."
cat > /etc/nginx/sites-available/ecb-kalender << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 60s;
    }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/ecb-kalender /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Test and reload
nginx -t
systemctl reload nginx
echo "✅ Nginx configured for $DOMAIN"

# ============ 7. SETUP DAILY BACKUP ============
echo ""
echo "💾 Setting up daily database backup..."
(crontab -l 2>/dev/null; echo "0 2 * * * docker cp ecb-kalender:/app/data/calendar.db /root/backups/calendar-\$(date +\%Y\%m\%d).db 2>/dev/null; find /root/backups -name 'calendar-*.db' -mtime +30 -delete") | crontab -
echo "✅ Daily backup cron job set (2:00 AM, keeps 30 days)"

# ============ 8. SSL CERTIFICATE ============
echo ""
echo "🔒 Setting up SSL certificate..."
echo "   Make sure your DNS A record for $DOMAIN points to this server!"
echo ""
read -p "   Set up SSL now? (y/n): " SETUP_SSL
if [ "$SETUP_SSL" = "y" ] || [ "$SETUP_SSL" = "Y" ]; then
  read -p "   Email for Let's Encrypt notifications: " LE_EMAIL
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL"
  echo "✅ SSL certificate installed"
else
  echo "⏭️  Skipping SSL setup. Run later with:"
  echo "   certbot --nginx -d $DOMAIN"
fi

# ============ DONE ============
echo ""
echo "============================================"
echo "  ✅ Server setup complete!"
echo "============================================"
echo ""
echo "  App directory:  $APP_DIR"
echo "  Domain:         $DOMAIN"
echo "  Backups:        /root/backups/"
echo ""
echo "  Next step: Upload your app and run deploy.sh"
echo "  From your local machine:"
echo "    bash deploy/deploy.sh root@$(hostname -I | awk '{print $1}')"
echo ""
