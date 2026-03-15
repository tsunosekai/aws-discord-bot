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
  lib32gcc-s1 lib32stdc++6 unzip zip curl software-properties-common ethtool

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
ExecStart=/home/steam/SatisfactoryDedicatedServer/FactoryServer.sh -unattended -Port=7777
Restart=on-failure
RestartSec=10
Nice=-5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SERVICEEOF

sudo systemctl daemon-reload
sudo systemctl enable satisfactory

# --- Engine.ini (Unreal Engine network tuning for AWS) ---
echo ">>> Creating Engine.ini for network bandwidth optimization..."
ENGINE_INI_DIR="${STEAM_HOME}/.config/Epic/FactoryGame/Saved/Config/LinuxServer"
sudo -u "${STEAM_USER}" mkdir -p "${ENGINE_INI_DIR}"
sudo -u "${STEAM_USER}" tee "${ENGINE_INI_DIR}/Engine.ini" > /dev/null << 'ENGINEEOF'
[/Script/Engine.Player]
ConfiguredInternetSpeed=104857600
ConfiguredLanSpeed=104857600

[/Script/OnlineSubsystemUtils.IpNetDriver]
MaxClientRate=104857600
MaxInternetClientRate=104857600
InitialConnectTimeout=120.0
ConnectionTimeout=120.0

[/Script/Engine.Engine]
bSmoothFrameRate=true
bUseFixedFrameRate=false
NetClientTicksPerSecond=120

[/Script/SocketSubsystemEpic.EpicNetDriver]
MaxClientRate=104857600
MaxInternetClientRate=104857600

[URL]
Port=7777
ENGINEEOF

# --- Create save data directory ---
echo ">>> Creating save data directory..."
SAVE_DIR="${STEAM_HOME}/.config/Epic/FactoryGame/Saved/SaveGames/server"
sudo -u "${STEAM_USER}" mkdir -p "${SAVE_DIR}"

# --- System tuning ---
echo ">>> Configuring kernel parameters for network performance..."
sudo tee /etc/sysctl.d/99-game-server.conf > /dev/null << 'SYSCTLEOF'
# UDP buffer sizes (Satisfactory uses UDP only)
net.core.rmem_max=26214400
net.core.wmem_max=26214400
net.core.rmem_default=1048576
net.core.wmem_default=1048576
net.ipv4.udp_mem=8388608 12582912 26214400
net.ipv4.udp_rmem_min=16384
net.ipv4.udp_wmem_min=16384

# Increase network backlog for burst UDP traffic
net.core.netdev_max_backlog=5000
SYSCTLEOF
sudo sysctl --system

# --- Network interface tuning (applied on boot) ---
echo ">>> Creating network tuning service..."
sudo tee /etc/systemd/system/network-tuning.service > /dev/null << 'NETEOF'
[Unit]
Description=Network interface tuning for game server
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/tune-network.sh

[Install]
WantedBy=multi-user.target
NETEOF

sudo tee /usr/local/bin/tune-network.sh > /dev/null << 'TUNESCRIPT'
#!/bin/bash
# Tune the primary network interface for low-latency game traffic
IFACE=$(ip route get 1.1.1.1 | awk '{print $5; exit}')
if [ -n "$IFACE" ]; then
  # Increase ring buffer sizes if supported
  ethtool -G "$IFACE" rx 4096 tx 4096 2>/dev/null || true
  # Disable interrupt coalescing for lower latency
  ethtool -C "$IFACE" adaptive-rx off adaptive-tx off rx-usecs 0 tx-usecs 0 2>/dev/null || true
  echo "Network tuning applied to $IFACE"
fi
TUNESCRIPT
sudo chmod +x /usr/local/bin/tune-network.sh
sudo systemctl daemon-reload
sudo systemctl enable network-tuning

# --- Cleanup ---
echo ">>> Cleaning up..."
sudo apt-get autoclean -y
sudo apt-get autoremove -y

echo "=== Provisioning complete ==="
