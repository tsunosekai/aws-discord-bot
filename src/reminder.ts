import { Client, TextChannel, EmbedBuilder } from "discord.js";
import { env, loadServersConfig } from "./config.js";
import { findInstanceByLabel } from "./aws/ec2.js";

const REMINDER_COLOR = 0xffcc00;
const CHECK_INTERVAL_MS = 60000;

let lastCheckedDate = "";
let intervalId: ReturnType<typeof setInterval> | null = null;

export function startReminder(client: Client): void {
  const { reminderTime, reminderChannelId } = env;

  if (!reminderTime || !reminderChannelId) {
    console.log("Reminder disabled (no channel ID or time configured)");
    return;
  }

  console.log(`Reminder enabled: ${reminderTime} → channel ${reminderChannelId}`);

  if (intervalId) {
    clearInterval(intervalId);
  }

  intervalId = setInterval(() => {
    checkAndNotify(client);
  }, CHECK_INTERVAL_MS);
}

export function stopReminder(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

async function checkAndNotify(client: Client): Promise<void> {
  const { reminderTime, reminderChannelId } = env;

  if (!reminderTime || !reminderChannelId) return;

  const now = new Date();
  const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const currentTime = `${jst.getHours().toString().padStart(2, "0")}:${jst.getMinutes().toString().padStart(2, "0")}`;
  const today = jst.toDateString();

  if (currentTime !== reminderTime || lastCheckedDate === today) {
    return;
  }

  lastCheckedDate = today;

  try {
    const config = loadServersConfig();
    const runningServers: { label: string; publicIp: string }[] = [];

    // 各サーバーのリージョンを走査
    for (const [_, serverConfig] of Object.entries(config.servers)) {
      const instance = await findInstanceByLabel(serverConfig.region, serverConfig.label);
      if (instance) {
        runningServers.push({
          label: instance.label,
          publicIp: instance.publicIp,
        });
      }
    }

    if (runningServers.length === 0) {
      return;
    }

    const channel = await client.channels.fetch(reminderChannelId);
    if (!channel || !(channel instanceof TextChannel)) {
      console.error("Reminder channel not found or not a text channel");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(REMINDER_COLOR)
      .setTitle("⚠️ サーバー稼働中リマインダー")
      .setDescription("以下のサーバーが稼働中です。使用していない場合は停止してください。")
      .setTimestamp();

    for (const server of runningServers) {
      embed.addFields({
        name: server.label,
        value: `IP: \`${server.publicIp}\``,
        inline: false,
      });
    }

    await channel.send({ embeds: [embed] });
    console.log(`Reminder sent: ${runningServers.length} server(s) running`);
  } catch (error) {
    console.error("Error sending reminder:", error);
  }
}
