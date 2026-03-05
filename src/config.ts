import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DownloadableFile {
  path: string;
  description: string;
  type?: "file" | "directory";
}

export interface ServerConfig {
  label: string;
  region: string;
  instanceType: string;
  amiPrefix: string;
  description: string;
  allowedGuilds?: string[];
  sshUser?: string;
  stopCommand?: string;
  startCommand?: string;
  downloadableFiles?: Record<string, DownloadableFile>;
  securityGroupPorts?: number[];
  rootVolumeSize?: number;
  spot?: boolean;
  keyPairName?: string;
  postStartHook?: string;
  hookConfig?: Record<string, unknown>;
}

export interface ServersConfig {
  adminGuilds?: string[];
  servers: Record<string, ServerConfig>;
}

let cachedConfig: ServersConfig | null = null;

export function loadServersConfig(): ServersConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const configPath = join(__dirname, "..", "servers.json");
  const content = readFileSync(configPath, "utf-8");
  cachedConfig = JSON.parse(content) as ServersConfig;
  return cachedConfig;
}

export function reloadServersConfig(): ServersConfig {
  cachedConfig = null;
  return loadServersConfig();
}

export function getServerConfig(name: string): ServerConfig | undefined {
  const config = loadServersConfig();
  return config.servers[name];
}

function isAdminGuild(guildId: string): boolean {
  const config = loadServersConfig();
  return config.adminGuilds?.includes(guildId) ?? false;
}

export function getServerNamesForGuild(guildId: string): string[] {
  const config = loadServersConfig();
  if (isAdminGuild(guildId)) {
    return Object.keys(config.servers);
  }
  return Object.entries(config.servers)
    .filter(([_, serverConfig]) => {
      if (!serverConfig.allowedGuilds || serverConfig.allowedGuilds.length === 0) {
        return true;
      }
      return serverConfig.allowedGuilds.includes(guildId);
    })
    .map(([name]) => name);
}

export function isServerAllowedForGuild(serverName: string, guildId: string): boolean {
  if (isAdminGuild(guildId)) return true;
  const config = getServerConfig(serverName);
  if (!config) return false;
  if (!config.allowedGuilds || config.allowedGuilds.length === 0) {
    return true;
  }
  return config.allowedGuilds.includes(guildId);
}

export const env = {
  get discordToken() {
    return process.env.DISCORD_TOKEN!;
  },
  get discordClientId() {
    return process.env.DISCORD_CLIENT_ID!;
  },
  get discordGuildId() {
    return process.env.DISCORD_GUILD_ID || "";
  },
  get awsRegion() {
    return process.env.AWS_REGION || "ap-northeast-1";
  },
  get awsKeyPairName() {
    return process.env.AWS_KEY_PAIR_NAME || "";
  },
  get allowedRoleName() {
    return process.env.ALLOWED_ROLE_NAME || "";
  },
  get reminderTime() {
    return process.env.REMINDER_TIME || "";
  },
  get reminderChannelId() {
    return process.env.REMINDER_CHANNEL_ID || "";
  },
  get sshPrivateKeyPath() {
    return process.env.SSH_PRIVATE_KEY_PATH || "";
  },
  get fileServerPort() {
    return parseInt(process.env.FILE_SERVER_PORT || "8080", 10);
  },
  get fileServerBaseUrl() {
    return process.env.FILE_SERVER_BASE_URL || "";
  },
  get fileDownloadDir() {
    return process.env.FILE_DOWNLOAD_DIR || "";
  },
  get fileRetention() {
    return parseInt(process.env.FILE_RETENTION || "3", 10);
  },
};
