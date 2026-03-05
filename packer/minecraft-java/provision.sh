#!/bin/bash
# Minecraft Java Edition Server AMI Provisioning Script
set -euo pipefail

MC_USER="minecraft"
MC_HOME="/home/${MC_USER}"
MC_DIR="${MC_HOME}/server"

echo "=== Minecraft Java Edition Server AMI Provisioning ==="

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
  openjdk-21-jre-headless curl jq screen

# --- Minecraft user ---
echo ">>> Creating minecraft user..."
sudo useradd -m -s /bin/bash "${MC_USER}" || true

# --- Minecraft Server ---
echo ">>> Setting up Minecraft server directory..."
sudo -u "${MC_USER}" mkdir -p "${MC_DIR}"

echo ">>> Downloading latest Minecraft server..."
MC_MANIFEST=$(curl -s https://launchermeta.mojang.com/mc/game/version_manifest_v2.json)
MC_LATEST=$(echo "${MC_MANIFEST}" | jq -r '.latest.release')
MC_VERSION_URL=$(echo "${MC_MANIFEST}" | jq -r --arg v "${MC_LATEST}" '.versions[] | select(.id == $v) | .url')
MC_VERSION_META=$(curl -s "${MC_VERSION_URL}")
MC_SERVER_URL=$(echo "${MC_VERSION_META}" | jq -r '.downloads.server.url')

echo ">>> Downloading Minecraft ${MC_LATEST}..."
sudo -u "${MC_USER}" curl -sL -o "${MC_DIR}/server.jar" "${MC_SERVER_URL}"

# --- Accept EULA ---
echo ">>> Accepting EULA..."
sudo -u "${MC_USER}" bash -c "echo 'eula=true' > ${MC_DIR}/eula.txt"

# --- Server properties ---
echo ">>> Creating server.properties..."
sudo -u "${MC_USER}" tee "${MC_DIR}/server.properties" > /dev/null << 'PROPSEOF'
server-port=25565
motd=Minecraft Server
max-players=10
view-distance=12
simulation-distance=8
online-mode=true
difficulty=normal
gamemode=survival
enable-command-block=true
PROPSEOF

# --- systemd service ---
echo ">>> Creating systemd service..."
sudo tee /etc/systemd/system/minecraft.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Minecraft Java Edition Server
After=network.target

[Service]
Type=simple
User=minecraft
WorkingDirectory=/home/minecraft/server
ExecStart=/usr/bin/java -Xmx3G -Xms1G -jar server.jar nogui
ExecStop=/bin/kill -SIGINT $MAINPID
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
