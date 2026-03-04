import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import { data as serverCommand } from "./discord/commands/server.js";

config();

const commands = [serverCommand.toJSON()];

const rest = new REST().setToken(process.env.DISCORD_TOKEN!);

async function main() {
  try {
    console.log("Started refreshing application (/) commands.");

    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.DISCORD_CLIENT_ID!,
          process.env.DISCORD_GUILD_ID
        ),
        { body: commands }
      );
      console.log(
        `Successfully registered commands for guild ${process.env.DISCORD_GUILD_ID}`
      );
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID!),
        { body: commands }
      );
      console.log("Successfully registered global commands.");
    }
  } catch (error) {
    console.error(error);
  }
}

main();
