import { config } from "dotenv";
config();

import { startBot } from "./discord/bot.js";
import { startFileServer } from "./file-server.js";

async function main() {
  console.log("Starting AWS Discord Bot...");

  try {
    startFileServer();
    await startBot();
    console.log("Bot is running!");
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main();
