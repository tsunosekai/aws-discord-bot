import { Client } from "ssh2";
import { readFileSync, createWriteStream } from "fs";
import { env } from "../config.js";

export interface SshConnectionOptions {
  host: string;
  user: string;
  privateKeyPath?: string;
}

export async function executeCommand(
  options: SshConnectionOptions,
  command: string
): Promise<string> {
  const { host, user, privateKeyPath } = options;
  const keyPath = privateKeyPath || env.sshPrivateKeyPath;

  if (!keyPath) {
    throw new Error("SSH秘密鍵のパスが設定されていません");
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let stdout = "";
        let stderr = "";

        stream.on("close", (code: number) => {
          conn.end();
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`コマンド失敗 (exit code: ${code}): ${stderr}`));
          }
        });

        stream.on("data", (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });

    conn.on("error", (err) => {
      reject(new Error(`SSH接続エラー: ${err.message}`));
    });

    conn.connect({
      host,
      port: 22,
      username: user,
      privateKey: readFileSync(keyPath),
      readyTimeout: 30000,
    });
  });
}

export async function downloadFile(
  options: SshConnectionOptions,
  remotePath: string,
  localPath: string
): Promise<void> {
  const { host, user, privateKeyPath } = options;
  const keyPath = privateKeyPath || env.sshPrivateKeyPath;

  if (!keyPath) {
    throw new Error("SSH秘密鍵のパスが設定されていません");
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = createWriteStream(localPath);

        readStream.on("error", (err: Error) => {
          conn.end();
          reject(new Error(`ファイル読み込みエラー: ${err.message}`));
        });

        writeStream.on("error", (err: Error) => {
          conn.end();
          reject(new Error(`ファイル書き込みエラー: ${err.message}`));
        });

        writeStream.on("close", () => {
          conn.end();
          resolve();
        });

        readStream.pipe(writeStream);
      });
    });

    conn.on("error", (err) => {
      reject(new Error(`SSH接続エラー: ${err.message}`));
    });

    conn.connect({
      host,
      port: 22,
      username: user,
      privateKey: readFileSync(keyPath),
      readyTimeout: 30000,
    });
  });
}

export async function uploadFile(
  options: SshConnectionOptions,
  localPath: string,
  remotePath: string
): Promise<void> {
  const { host, user, privateKeyPath } = options;
  const keyPath = privateKeyPath || env.sshPrivateKeyPath;

  if (!keyPath) {
    throw new Error("SSH秘密鍵のパスが設定されていません");
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        sftp.fastPut(localPath, remotePath, (err) => {
          conn.end();
          if (err) {
            reject(new Error(`ファイルアップロードエラー: ${err.message}`));
          } else {
            resolve();
          }
        });
      });
    });

    conn.on("error", (err) => {
      reject(new Error(`SSH接続エラー: ${err.message}`));
    });

    conn.connect({
      host,
      port: 22,
      username: user,
      privateKey: readFileSync(keyPath),
      readyTimeout: 30000,
    });
  });
}

export async function uploadDirectoryFromZip(
  options: SshConnectionOptions,
  localPath: string,
  remotePath: string
): Promise<void> {
  const timestamp = Date.now();
  const tempZipPath = `/tmp/upload_${timestamp}.zip`;

  await uploadFile(options, localPath, tempZipPath);

  try {
    // 既存ディレクトリのオーナーを維持、なければ親ディレクトリのオーナーを使用
    await executeCommand(
      options,
      `sudo bash -c 'OWNER=$(stat -c "%U:%G" "${remotePath}" 2>/dev/null || stat -c "%U:%G" "$(dirname "${remotePath}")"); mkdir -p "${remotePath}" && cd "${remotePath}" && unzip -o "${tempZipPath}" && chown -R "$OWNER" "${remotePath}"'`
    );
  } finally {
    await executeCommand(options, `rm -f "${tempZipPath}"`).catch(() => {});
  }
}

export async function downloadDirectoryAsZip(
  options: SshConnectionOptions,
  remotePath: string,
  localPath: string
): Promise<void> {
  const timestamp = Date.now();
  const tempZipPath = `/tmp/download_${timestamp}.zip`;

  await executeCommand(
    options,
    `sudo bash -c 'cd "${remotePath}" && zip -r "${tempZipPath}" .'`
  );

  try {
    await downloadFile(options, tempZipPath, localPath);
  } finally {
    await executeCommand(options, `rm -f "${tempZipPath}"`).catch(() => {});
  }
}
