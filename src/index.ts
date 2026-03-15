import { config } from "dotenv";
config();

import { startBot } from "./discord/bot.js";
import { startFileServer } from "./file-server.js";

// プロセスクラッシュを防止
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

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
