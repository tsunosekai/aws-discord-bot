import express, { Express } from "express";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { randomUUID } from "crypto";
import { join, extname } from "path";
import { env } from "./config.js";

let app: Express | null = null;

export function startFileServer(): void {
  const { fileServerPort, fileDownloadDir } = env;

  if (!fileDownloadDir) {
    console.log("FILE_DOWNLOAD_DIR が設定されていないため、ファイルサーバーは起動しません");
    return;
  }

  if (!existsSync(fileDownloadDir)) {
    mkdirSync(fileDownloadDir, { recursive: true });
  }

  app = express();

  app.use("/files", express.static(fileDownloadDir));

  app.listen(fileServerPort, () => {
    console.log(`ファイルサーバーを起動しました: ポート ${fileServerPort}`);
  });
}

export function generateDownloadFilename(
  serverName: string,
  fileKey: string,
  originalPath: string
): string {
  const ext = extname(originalPath);
  const timestamp = Date.now();
  const uuid = randomUUID().slice(0, 8);
  return `${serverName}_${fileKey}_${timestamp}_${uuid}${ext}`;
}

export function getLocalFilePath(filename: string): string {
  return join(env.fileDownloadDir, filename);
}

export function getFileUrl(filename: string): string {
  const baseUrl = env.fileServerBaseUrl;
  if (baseUrl) {
    return `${baseUrl}/${filename}`;
  }
  return `http://localhost:${env.fileServerPort}/files/${filename}`;
}

export function cleanupOldFiles(serverName: string, fileKey: string): void {
  const { fileDownloadDir, fileRetention } = env;

  if (!fileDownloadDir || !existsSync(fileDownloadDir)) {
    return;
  }

  const prefix = `${serverName}_${fileKey}_`;
  const files = readdirSync(fileDownloadDir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => ({
      name: f,
      path: join(fileDownloadDir, f),
      mtime: statSync(join(fileDownloadDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const filesToDelete = files.slice(fileRetention);
  for (const file of filesToDelete) {
    try {
      unlinkSync(file.path);
      console.log(`古いファイルを削除: ${file.name}`);
    } catch (error) {
      console.error(`ファイル削除エラー: ${file.name}`, error);
    }
  }
}

export interface SavedFile {
  fileKey: string;
  filename: string;
  url: string;
  timestamp: Date;
}

export function listSavedFiles(serverName: string): SavedFile[] {
  const { fileDownloadDir } = env;

  if (!fileDownloadDir || !existsSync(fileDownloadDir)) {
    return [];
  }

  const prefix = `${serverName}_`;
  const files = readdirSync(fileDownloadDir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => {
      const path = join(fileDownloadDir, f);
      const stat = statSync(path);
      const parts = f.split("_");
      const fileKey = parts[1] || "";
      return {
        fileKey,
        filename: f,
        url: getFileUrl(f),
        timestamp: stat.mtime,
      };
    })
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  return files;
}
