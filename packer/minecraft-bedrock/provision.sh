#!/bin/bash
# Minecraft Bedrock Edition Server AMI Provisioning Script
set -euo pipefail

MC_USER="minecraft"
MC_HOME="/home/${MC_USER}"
MC_DIR="${MC_HOME}/server"

echo "=== Minecraft Bedrock Edition Server AMI Provisioning ==="

# --- Wait for cloud-init ---
echo ">>> Waiting for cloud-init to finish..."
cloud-init status --wait || true

echo ">>> Waiting for apt locks to be released..."
while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 5; done
while sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do sleep 5; done

# --- System packages ---
echo ">>> Updating apt cache..."
sudo apt-get update -y

echo ">>> Installing required packages..."
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl unzip zip libcurl4 openssl

# --- Minecraft user ---
echo ">>> Creating minecraft user..."
sudo useradd -m -s /bin/bash "${MC_USER}" || true

# --- Minecraft Bedrock Server ---
echo ">>> Setting up Minecraft Bedrock server directory..."
sudo -u "${MC_USER}" mkdir -p "${MC_DIR}"

echo ">>> Unzipping pre-uploaded Minecraft Bedrock server..."
sudo -u "${MC_USER}" unzip -o /tmp/bedrock-server.zip -d "${MC_DIR}"
rm -f /tmp/bedrock-server.zip

# --- Server properties ---
echo ">>> Configuring server.properties..."
sudo -u "${MC_USER}" tee "${MC_DIR}/server.properties" > /dev/null << 'PROPSEOF'
server-port=19132
server-portv6=19133
server-name=Bedrock Server
max-players=10
view-distance=12
tick-distance=8
online-mode=true
difficulty=normal
gamemode=survival
level-name=world
PROPSEOF

# --- systemd service ---
echo ">>> Creating systemd service..."
sudo tee /etc/systemd/system/minecraft.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Minecraft Bedrock Edition Server
After=network.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/home/minecraft/server
Environment=LD_LIBRARY_PATH=/home/minecraft/server
ExecStart=/home/minecraft/server/bedrock_server
Restart=on-failure
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable minecraft

# --- Cleanup ---
echo ">>> Cleaning up..."
sudo apt-get autoclean -y
sudo apt-get autoremove -y

echo "=== Provisioning complete ==="
