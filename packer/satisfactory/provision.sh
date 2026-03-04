#!/bin/bash
# Satisfactory Dedicated Server AMI Provisioning Script
set -euo pipefail

STEAM_USER="steam"
STEAM_HOME="/home/${STEAM_USER}"
STEAMCMD_DIR="${STEAM_HOME}/steamcmd"
SATISFACTORY_DIR="${STEAM_HOME}/SatisfactoryDedicatedServer"
SATISFACTORY_APP_ID="1690800"

echo "=== Satisfactory Server AMI Provisioning ==="

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
sudo dpkg --add-architecture i386
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  lib32gcc-s1 lib32stdc++6 unzip zip curl software-properties-common

# --- Steam user ---
echo ">>> Creating steam user..."
sudo useradd -m -s /bin/bash "${STEAM_USER}" || true

# --- SteamCMD ---
echo ">>> Installing SteamCMD..."
sudo -u "${STEAM_USER}" mkdir -p "${STEAMCMD_DIR}"
wget -qO /tmp/steamcmd_linux.tar.gz https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz
sudo -u "${STEAM_USER}" tar xzf /tmp/steamcmd_linux.tar.gz -C "${STEAMCMD_DIR}"
rm -f /tmp/steamcmd_linux.tar.gz

# --- Satisfactory Dedicated Server ---
echo ">>> Installing Satisfactory Dedicated Server (this may take a while)..."
# SteamCMD sometimes fails on first attempt with "Missing configuration", retry up to 3 times
for i in 1 2 3; do
  echo ">>> SteamCMD attempt ${i}..."
  if sudo -u "${STEAM_USER}" "${STEAMCMD_DIR}/steamcmd.sh" \
    +force_install_dir "${SATISFACTORY_DIR}" \
    +login anonymous \
    +app_update "${SATISFACTORY_APP_ID}" validate \
    +quit; then
    echo ">>> SteamCMD succeeded on attempt ${i}"
    break
  fi
  if [ "$i" -eq 3 ]; then
    echo ">>> SteamCMD failed after 3 attempts"
    exit 1
  fi
  echo ">>> SteamCMD failed, retrying in 10 seconds..."
  sleep 10
done

# --- systemd service ---
echo ">>> Creating systemd service..."
sudo tee /etc/systemd/system/satisfactory.service > /dev/null << 'SERVICEEOF'
[Unit]
Description=Satisfactory Dedicated Server
After=network.target

[Service]
Type=simple
User=steam
WorkingDirectory=/home/steam/SatisfactoryDedicatedServer
ExecStartPre=/home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/SatisfactoryDedicatedServer +login anonymous +app_update 1690800 +quit
ExecStart=/home/steam/SatisfactoryDedicatedServer/FactoryServer.sh -unattended -Port=7777
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable satisfactory

# --- System tuning ---
echo ">>> Configuring file descriptor limits..."
sudo tee /etc/security/limits.d/satisfactory.conf > /dev/null << 'LIMITSEOF'
steam soft nofile 65536
steam hard nofile 65536
LIMITSEOF

echo ">>> Configuring kernel parameters..."
sudo sysctl -w net.core.rmem_max=16777216
sudo sysctl -w net.core.wmem_max=16777216
sudo tee -a /etc/sysctl.conf > /dev/null << 'SYSCTLEOF'
net.core.rmem_max=16777216
net.core.wmem_max=16777216
SYSCTLEOF

# --- Cleanup ---
echo ">>> Cleaning up..."
sudo apt-get autoclean -y
sudo apt-get autoremove -y

echo "=== Provisioning complete ==="
