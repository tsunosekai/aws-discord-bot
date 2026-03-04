import {
  Client,
  GatewayIntentBits,
  Events,
  Collection,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
} from "discord.js";
import { env } from "../config.js";
import * as serverCommand from "./commands/server.js";
import { startReminder } from "../reminder.js";

interface Command {
  data: { name: string };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

export function createBot(): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const commands = new Collection<string, Command>();
  commands.set(serverCommand.data.name, serverCommand);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    startReminder(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        console.error(`Command ${interaction.commandName} not found`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(`Error executing ${interaction.commandName}:`, error);
        const reply = {
          content: "コマンドの実行中にエラーが発生しました。",
          ephemeral: true,
        };
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      }
    } else if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      if (!command?.autocomplete) return;

      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(`Autocomplete error for ${interaction.commandName}:`, error);
      }
    }
  });

  return client;
}

export async function startBot(): Promise<Client> {
  const client = createBot();
  await client.login(env.discordToken);
  return client;
}
