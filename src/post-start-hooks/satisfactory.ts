// Satisfactory Dedicated Server 起動後フック
// サーバークレーム → セーブデータロードを自動実行する

import https from "node:https";

export interface SatisfactoryHookConfig {
  adminPassword?: string;
  apiPort?: number;
}

// Satisfactory API は自己署名証明書を使用するため検証を無効化
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString(),
            contentType: res.headers["content-type"] || "",
          })
        );
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function apiCall(
  baseUrl: string,
  functionName: string,
  body: Record<string, unknown> = {},
  authToken?: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await httpsPost(
    baseUrl,
    headers,
    JSON.stringify({ function: functionName, data: body })
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Satisfactory API ${functionName} failed (${res.status}): ${res.body}`);
  }
  if (res.contentType.includes("application/json")) {
    return JSON.parse(res.body) as Record<string, unknown>;
  }
  return {};
}

async function waitForApi(baseUrl: string, maxRetries = 30, intervalMs = 10000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await apiCall(baseUrl, "HealthCheck", { ClientCustomData: "" });
      console.log(`Satisfactory API is ready (attempt ${i + 1})`);
      return;
    } catch (e) {
      console.log(`waitForApi attempt ${i + 1}/${maxRetries}: ${e instanceof Error ? e.message : e}`);
      if (i === maxRetries - 1) throw new Error("Satisfactory API did not become available");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function postStartHook(
  host: string,
  serverLabel: string,
  hookConfig: Record<string, unknown>
): Promise<void> {
  const config = hookConfig as SatisfactoryHookConfig;
  const adminPassword = config.adminPassword || "admin";
  const apiPort = config.apiPort || 7777;
  const baseUrl = `https://${host}:${apiPort}/api/v1`;

  // 1. API の応答を待つ
  await waitForApi(baseUrl);

  // 2. ログイン: まず PasswordlessLogin を試し、失敗したら PasswordLogin を使う
  let token: string | undefined;

  try {
    const loginRes = await apiCall(baseUrl, "PasswordlessLogin", {
      MinimumPrivilegeLevel: "InitialAdmin",
    });
    token = (loginRes as { data?: { authenticationToken?: string } }).data?.authenticationToken;
  } catch {
    console.log("PasswordlessLogin failed (server likely already claimed), trying PasswordLogin");
  }

  if (token) {
    // 3. 未クレームサーバーの場合: ClaimServer でサーバークレーム
    try {
      const claimRes = await apiCall(baseUrl, "ClaimServer", {
        ServerName: serverLabel,
        AdminPassword: adminPassword,
      }, token);
      const claimToken = (claimRes as { data?: { authenticationToken?: string } }).data?.authenticationToken;
      if (claimToken) token = claimToken;
      console.log("Server claimed successfully");
    } catch (e) {
      console.log("ClaimServer failed (may already be claimed):", e instanceof Error ? e.message : e);
    }
  }

  // クレーム済みサーバーまたはクレーム後: AdminPassword でログイン
  try {
    const relogin = await apiCall(baseUrl, "PasswordLogin", {
      MinimumPrivilegeLevel: "Administrator",
      Password: adminPassword,
    });
    const newToken = (relogin as { data?: { authenticationToken?: string } }).data?.authenticationToken;
    if (newToken) token = newToken;
  } catch (e) {
    console.log("PasswordLogin failed:", e instanceof Error ? e.message : e);
  }

  if (!token) {
    throw new Error("Failed to obtain auth token via any login method");
  }

  // 4. QueryServerState で現在の状態を確認
  const currentState = await apiCall(baseUrl, "QueryServerState", {}, token);
  console.log("QueryServerState:", JSON.stringify(currentState, null, 2));

  const gameState = (currentState as any)?.data?.serverGameState;
  if (gameState?.isGameRunning) {
    console.log("Game is already running, no need to load");
    return;
  }

  // 5. EnumerateSessions でセッション一覧取得
  const sessionsRes = await apiCall(baseUrl, "EnumerateSessions", {}, token);
  console.log("EnumerateSessions:", JSON.stringify(sessionsRes, null, 2));

  const sessions = (sessionsRes as any)?.data?.sessions as Array<Record<string, unknown>> | undefined;

  // セッションの saveHeaders から最新セーブ名を取得
  let saveName: string | undefined;
  if (sessions && sessions.length > 0) {
    const latest = sessions[0];
    console.log("Latest session:", JSON.stringify(latest, null, 2));

    // saveHeaders 配列の先頭からセーブ名を取得
    const saveHeaders = (latest.saveHeaders as Array<Record<string, unknown>>) || [];
    if (saveHeaders.length > 0) {
      saveName = (saveHeaders[0].saveName as string) || (saveHeaders[0].SaveName as string);
    }
    // saveHeaders がない場合のフォールバック
    if (!saveName) {
      saveName = (latest.saveName as string) || (latest.SaveName as string);
    }
    console.log("Resolved saveName:", saveName);
  }

  if (!saveName) {
    // セッションが無い or saveName が解決できない場合は新規ゲーム作成
    console.log("No save found, creating new game");
    try {
      await apiCall(baseUrl, "CreateNewGame", {
        NewGameData: {
          SessionName: serverLabel,
        },
      }, token);
    } catch (e) {
      console.log("CreateNewGame failed (may need manual setup):", e);
    }
  } else {
    // 6. セーブを LoadGame でロード
    console.log("Loading save:", saveName);
    await apiCall(baseUrl, "LoadGame", {
      SaveName: saveName,
      EnableAdvancedGameSettings: true,
    }, token);
  }

  // 6. ロード完了を QueryServerState で確認
  // LoadGame 後、API は一時的に利用不可になるためエラーを無視してリトライする
  for (let i = 0; i < 60; i++) {
    try {
      const stateRes = await apiCall(baseUrl, "QueryServerState", {}, token);
      const serverState = (stateRes as { data?: { serverGameState?: { isGameRunning?: boolean } } }).data?.serverGameState;
      if (serverState?.isGameRunning) {
        console.log("Satisfactory server is running and game is loaded");
        return;
      }
    } catch (e) {
      console.log(`QueryServerState attempt ${i + 1}/60 failed (API temporarily unavailable during load):`, e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error("Game did not start after LoadGame (timeout)");
}
