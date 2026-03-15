import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AutocompleteInteraction,
  GuildMember,
} from "discord.js";
import {
  getServerConfig,
  getServerNamesForGuild,
  isServerAllowedForGuild,
  loadServersConfig,
  env,
  ServerConfig,
} from "../../config.js";
import { executeCommand, downloadFile, downloadDirectoryAsZip, uploadFile, uploadDirectoryFromZip } from "../../sftp/client.js";
import {
  generateDownloadFilename,
  getLocalFilePath,
  getFileUrl,
  cleanupOldFiles,
  listSavedFiles,
} from "../../file-server.js";
import {
  findInstanceByLabel,
  findAmisByPrefix,
  launchInstanceFromAmi,
  terminateInstance,
  waitForInstanceReady,
  ensureSecurityGroup,
  getInstanceTypeInfo,
} from "../../aws/ec2.js";
import { runPostStartHook } from "../../post-start-hooks/index.js";

const COLORS = {
  SUCCESS: 0x00ff00,
  WARNING: 0xff9900,
  INFO: 0x0099ff,
  INACTIVE: 0x999999,
} as const;

const MESSAGES = {
  SERVER_NOT_FOUND: (name: string) => `サーバー "${name}" は設定されていません。`,
  NO_PERMISSION: (role: string) => `このコマンドを使用する権限がありません。必要なロール: "${role}"`,
  NO_SERVERS: "利用可能なサーバーがありません。",
} as const;

function hasAllowedRole(interaction: ChatInputCommandInteraction): boolean {
  const allowedRoleName = env.allowedRoleName;
  if (!allowedRoleName) return true;

  const member = interaction.member as GuildMember | null;
  if (!member) return false;

  return member.roles.cache.some(
    (role) => role.name.toLowerCase() === allowedRoleName.toLowerCase()
  );
}

function validateServerAccess(
  serverName: string,
  guildId: string
): { config: ServerConfig } | { error: string } {
  const config = getServerConfig(serverName);
  if (!config || !isServerAllowedForGuild(serverName, guildId)) {
    return { error: MESSAGES.SERVER_NOT_FOUND(serverName) };
  }
  return { config };
}

const regionNames: Record<string, string> = {
  "ap-northeast-1": "東京",
  "ap-northeast-2": "ソウル",
  "ap-southeast-1": "シンガポール",
  "us-west-2": "オレゴン",
  "us-east-1": "バージニア",
  "eu-west-1": "アイルランド",
  "eu-central-1": "フランクフルト",
  "ap-southeast-2": "シドニー",
};

function formatRegion(region: string): string {
  return regionNames[region] || region;
}

export const data = new SlashCommandBuilder()
  .setName("server")
  .setDescription("EC2 インスタンスを管理")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("start")
      .setDescription("AMI からサーバーを起動")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("サーバー名")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stop")
      .setDescription("サーバーを停止してセーブデータを保存")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("サーバー名")
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("サーバーの状態を確認")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("サーバー名（省略時は全サーバー表示）")
          .setRequired(false)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("list").setDescription("登録済みサーバー一覧を表示")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("files")
      .setDescription("保存済みファイル一覧を表示")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("サーバー名")
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

export async function autocomplete(
  interaction: AutocompleteInteraction
): Promise<void> {
  const focusedValue = interaction.options.getFocused();
  const guildId = interaction.guildId || "";
  const serverNames = getServerNamesForGuild(guildId);
  const config = loadServersConfig();
  const filtered = serverNames.filter((name) => {
    const label = config.servers[name]?.label || name;
    return (
      name.toLowerCase().includes(focusedValue.toLowerCase()) ||
      label.toLowerCase().includes(focusedValue.toLowerCase())
    );
  });
  await interaction.respond(
    filtered.slice(0, 25).map((name) => ({
      name: config.servers[name]?.label || name,
      value: name,
    }))
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!hasAllowedRole(interaction)) {
    await interaction.reply({
      content: MESSAGES.NO_PERMISSION(env.allowedRoleName),
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "start":
      await handleStart(interaction);
      break;
    case "stop":
      await handleStop(interaction);
      break;
    case "status":
      await handleStatus(interaction);
      break;
    case "list":
      await handleList(interaction);
      break;
    case "files":
      await handleFiles(interaction);
      break;
  }
}

async function handleStart(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const serverName = interaction.options.getString("name", true);
  const guildId = interaction.guildId || "";

  const validation = validateServerAccess(serverName, guildId);
  if ("error" in validation) {
    await interaction.reply({ content: validation.error, ephemeral: true });
    return;
  }
  const { config } = validation;

  const existingInstance = await findInstanceByLabel(config.region, config.label);
  if (existingInstance) {
    await interaction.reply({
      content: `サーバー "${serverName}" は既に起動中です。\nIP: \`${existingInstance.publicIp}\``,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    const amis = await findAmisByPrefix(config.region, config.amiPrefix);
    if (amis.length === 0) {
      await interaction.editReply(
        `"${serverName}" の AMI が見つかりません（プレフィックス: ${config.amiPrefix}）`
      );
      return;
    }

    const latestAmi = amis[0];
    await interaction.editReply(
      `"${serverName}" を起動中... AMI: ${latestAmi.name}`
    );

    const sgId = await ensureSecurityGroup(
      config.region,
      serverName,
      config.securityGroupPorts || []
    );

    const keyPairName = config.keyPairName || env.awsKeyPairName;
    if (!keyPairName) {
      await interaction.editReply(
        "キーペア名が設定されていません。AWS_KEY_PAIR_NAME を .env に設定してください。"
      );
      return;
    }

    const instance = await launchInstanceFromAmi({
      region: config.region,
      amiId: latestAmi.amiId,
      instanceType: config.instanceType,
      label: config.label,
      securityGroupId: sgId,
      keyPairName,
      rootVolumeSize: config.rootVolumeSize,
      spot: config.spot,
    });

    await interaction.editReply(`サーバーの準備完了を待機中...`);

    const readyInstance = await waitForInstanceReady(config.region, instance.instanceId);

    // セーブデータをアップロード
    if (config.sshUser && config.downloadableFiles) {
      await interaction.editReply(`セーブデータをアップロード中...`);
      await uploadSaveDataToServer(serverName, config, readyInstance.publicIp);
    }

    // ゲームサービスを起動
    if (config.sshUser && config.startCommand) {
      await interaction.editReply(`サーバーを起動中...`);
      const sshOptions = { host: readyInstance.publicIp, user: config.sshUser };
      await executeCommand(sshOptions, config.startCommand);
    }

    // 起動後フックの実行
    if (config.postStartHook) {
      await interaction.editReply(`起動後セットアップを実行中...`);
      try {
        await runPostStartHook(
          config.postStartHook,
          readyInstance.publicIp,
          config.label,
          config.hookConfig || {}
        );
      } catch (error) {
        console.error("Error in post-start hook:", error);
        await interaction.editReply(
          `⚠️ 起動後セットアップに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}\nサーバーは起動していますが、手動でセットアップが必要かもしれません。`
        );
      }
    }

    const specs = await getInstanceTypeInfo(config.region, config.instanceType);
    const specsText = specs
      ? `${specs.vcpus} vCPU / ${specs.memoryGiB} GB RAM`
      : config.instanceType;

    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle(`${config.label} 起動完了`)
      .addFields(
        { name: "IP アドレス", value: `\`${readyInstance.publicIp}\``, inline: true },
        { name: "状態", value: "稼働中", inline: true },
        { name: "リージョン", value: formatRegion(config.region), inline: true },
        { name: "スペック", value: `${config.instanceType}\n${specsText}`, inline: true },
        { name: "ストレージ", value: config.rootVolumeSize ? `${config.rootVolumeSize} GB (gp3)` : "-", inline: true },
        { name: "モード", value: config.spot ? "スポット" : "オンデマンド", inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (error) {
    console.error("Error starting server:", error);
    await interaction.editReply(
      `サーバーの起動に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`
    );
  }
}

async function downloadFilesFromServer(
  serverName: string,
  config: ServerConfig,
  host: string
): Promise<{ name: string; url: string; description: string }[]> {
  const downloadedFiles: { name: string; url: string; description: string }[] = [];

  if (!config.downloadableFiles || !config.sshUser) {
    return downloadedFiles;
  }

  const sshOptions = {
    host,
    user: config.sshUser,
  };

  for (const [fileKey, fileConfig] of Object.entries(config.downloadableFiles)) {
    try {
      const isDirectory = fileConfig.type === "directory";
      const ext = isDirectory ? ".zip" : "";
      const filename = generateDownloadFilename(serverName, fileKey, fileConfig.path + ext);
      const localPath = getLocalFilePath(filename);

      if (isDirectory) {
        await downloadDirectoryAsZip(sshOptions, fileConfig.path, localPath);
      } else {
        await downloadFile(sshOptions, fileConfig.path, localPath);
      }

      downloadedFiles.push({
        name: fileKey,
        url: getFileUrl(filename),
        description: fileConfig.description,
      });

      cleanupOldFiles(serverName, fileKey);
    } catch (error) {
      console.error(`Failed to download ${fileKey}:`, error);
    }
  }

  return downloadedFiles;
}

async function uploadSaveDataToServer(
  serverName: string,
  config: ServerConfig,
  host: string
): Promise<void> {
  if (!config.downloadableFiles || !config.sshUser) return;

  const sshOptions = { host, user: config.sshUser };

  for (const [fileKey, fileConfig] of Object.entries(config.downloadableFiles)) {
    // 最新のバックアップファイルを探す
    const savedFiles = listSavedFiles(serverName).filter(
      (f) => f.fileKey === fileKey
    );
    if (savedFiles.length === 0) {
      console.log(`No saved files found for ${serverName}/${fileKey}, skipping upload`);
      continue;
    }

    const latestFile = savedFiles[0];
    const localPath = getLocalFilePath(latestFile.filename);
    const isDirectory = fileConfig.type === "directory";

    try {
      if (isDirectory) {
        await uploadDirectoryFromZip(sshOptions, localPath, fileConfig.path);
      } else {
        await uploadFile(sshOptions, localPath, fileConfig.path);
      }
      console.log(`Uploaded ${fileKey} to ${host}:${fileConfig.path}`);
    } catch (error) {
      console.error(`Failed to upload ${fileKey}:`, error);
    }
  }
}

async function handleStop(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const serverName = interaction.options.getString("name", true);
  const guildId = interaction.guildId || "";

  const validation = validateServerAccess(serverName, guildId);
  if ("error" in validation) {
    await interaction.reply({ content: validation.error, ephemeral: true });
    return;
  }
  const { config } = validation;

  const instance = await findInstanceByLabel(config.region, config.label);
  if (!instance) {
    await interaction.reply({
      content: `サーバー "${serverName}" は起動していません。`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  let downloadedFiles: { name: string; url: string; description: string }[] = [];

  try {
    const hasDownloadConfig = config.sshUser && config.downloadableFiles && Object.keys(config.downloadableFiles).length > 0;

    if (hasDownloadConfig) {
      if (config.stopCommand) {
        await interaction.editReply(`サービスを停止中...`);
        const sshOptions = { host: instance.publicIp, user: config.sshUser! };
        await executeCommand(sshOptions, config.stopCommand);
      }

      await interaction.editReply(`セーブデータをダウンロード中...`);
      downloadedFiles = await downloadFilesFromServer(serverName, config, instance.publicIp);
    }

    await interaction.editReply(`インスタンスを削除中...`);
    await terminateInstance(config.region, instance.instanceId);

    const downloadLinks = downloadedFiles.length > 0
      ? downloadedFiles.map((f) => `**${f.description}**: ${f.url}`).join("\n")
      : null;

    const embed = new EmbedBuilder()
      .setColor(COLORS.WARNING)
      .setTitle(`${config.label} 停止完了`)
      .setDescription(downloadLinks)
      .addFields(
        { name: "状態", value: "セーブデータ保存済み・停止", inline: true }
      )
      .setTimestamp();

    await interaction.editReply({ content: "", embeds: [embed] });
  } catch (error) {
    console.error("Error stopping server:", error);
    await interaction.editReply(
      `⚠️ サーバーの停止に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}\nサーバーは削除されていません。手動で確認してください。`
    );
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const serverName = interaction.options.getString("name");
  const guildId = interaction.guildId || "";

  await interaction.deferReply();

  try {
    if (serverName) {
      const validation = validateServerAccess(serverName, guildId);
      if ("error" in validation) {
        await interaction.editReply(validation.error);
        return;
      }
      const { config } = validation;

      const instance = await findInstanceByLabel(config.region, config.label);
      const savedFiles = listSavedFiles(serverName);

      const embed = new EmbedBuilder()
        .setColor(instance ? COLORS.SUCCESS : COLORS.INACTIVE)
        .setTitle(`${config.label}`)
        .setDescription(config.description)
        .addFields(
          {
            name: "状態",
            value: instance ? "稼働中" : "停止中",
            inline: true,
          },
          {
            name: "IP アドレス",
            value: instance ? `\`${instance.publicIp}\`` : "-",
            inline: true,
          },
          { name: "セーブデータ", value: savedFiles.length > 0 ? `${savedFiles.length} 件` : "なし", inline: true }
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } else {
      const config = loadServersConfig();
      const serverNames = getServerNamesForGuild(guildId);

      if (serverNames.length === 0) {
        await interaction.editReply(MESSAGES.NO_SERVERS);
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle("サーバー状態")
        .setTimestamp();

      for (const name of serverNames) {
        const serverConfig = config.servers[name];
        const instance = await findInstanceByLabel(serverConfig.region, serverConfig.label);

        embed.addFields({
          name: `${serverConfig.label}`,
          value: instance
            ? `稼働中 - \`${instance.publicIp}\``
            : "停止中",
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    }
  } catch (error) {
    console.error("Error getting status:", error);
    await interaction.editReply(
      `状態の取得に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`
    );
  }
}

async function handleList(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guildId = interaction.guildId || "";
  const config = loadServersConfig();
  const allowedServerNames = getServerNamesForGuild(guildId);

  if (allowedServerNames.length === 0) {
    await interaction.reply({
      content: MESSAGES.NO_SERVERS,
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle("登録済みサーバー")
    .setDescription("`/server start <name>` でサーバーを起動できます")
    .setTimestamp();

  for (const name of allowedServerNames) {
    const serverConfig = config.servers[name];
    embed.addFields({
      name: `${name}`,
      value: `${serverConfig.description}\nリージョン: ${formatRegion(serverConfig.region)} | タイプ: ${serverConfig.instanceType}`,
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleFiles(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const serverName = interaction.options.getString("name", true);
  const guildId = interaction.guildId || "";

  const validation = validateServerAccess(serverName, guildId);
  if ("error" in validation) {
    await interaction.reply({ content: validation.error, ephemeral: true });
    return;
  }
  const { config } = validation;

  const files = listSavedFiles(serverName);

  if (files.length === 0) {
    await interaction.reply({
      content: `"${serverName}" の保存済みファイルはありません。`,
      ephemeral: true,
    });
    return;
  }

  const filesByKey = new Map<string, typeof files>();
  for (const file of files) {
    const existing = filesByKey.get(file.fileKey) || [];
    existing.push(file);
    filesByKey.set(file.fileKey, existing);
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`${config.label} - 保存済みファイル`)
    .setTimestamp();

  for (const [fileKey, keyFiles] of filesByKey) {
    const fileConfig = config.downloadableFiles?.[fileKey];
    const description = fileConfig?.description || fileKey;

    const fileList = keyFiles
      .slice(0, 5)
      .map((f) => {
        const date = f.timestamp.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
        return `[${date}](${f.url})`;
      })
      .join("\n");

    embed.addFields({
      name: description,
      value: fileList || "ファイルなし",
      inline: false,
    });
  }

  await interaction.reply({ embeds: [embed] });
}
