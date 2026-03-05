import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import { data as serverCommand } from "./discord/commands/server.js";
import { loadServersConfig } from "./config.js";

config();

const commands = [serverCommand.toJSON()];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

async function main() {
  try {
    console.log("Started refreshing application (/) commands.");

    // Collect all unique guild IDs from config
    const guildIds = new Set<string>();

    if (process.env.DISCORD_GUILD_ID) {
      guildIds.add(process.env.DISCORD_GUILD_ID);
    }

    const serversConfig = loadServersConfig();
    if (serversConfig.adminGuilds) {
      for (const id of serversConfig.adminGuilds) {
        guildIds.add(id);
      }
    }
    for (const server of Object.values(serversConfig.servers)) {
      if (server.allowedGuilds) {
        for (const id of server.allowedGuilds) {
          guildIds.add(id);
        }
      }
    }

    if (guildIds.size > 0) {
      for (const guildId of guildIds) {
        await rest.put(
          Routes.applicationGuildCommands(
            process.env.DISCORD_CLIENT_ID!,
            guildId
          ),
          { body: commands }
        );
        console.log(`Registered commands for guild ${guildId}`);
      }
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
        { body: commands }
      );
      console.log("Registered global commands.");
    }
  } catch (error) {
    console.error(error);
  }
}

main();
