// Satisfactory Dedicated Server 起動後フック
// サーバークレーム → セーブデータロードを自動実行する

export interface SatisfactoryHookConfig {
  adminPassword?: string;
  apiPort?: number;
}

async function apiCall(
  baseUrl: string,
  functionName: string,
  body: Record<string, unknown> = {},
  authToken?: string
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  const res = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ function: functionName, data: body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Satisfactory API ${functionName} failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as Record<string, unknown>;
  }
  return {};
}

async function waitForApi(baseUrl: string, maxRetries = 30, intervalMs = 10000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await apiCall(baseUrl, "HealthCheck", { ClientCustomData: "" });
      return;
    } catch {
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

  // 2. PasswordlessLogin (InitialAdmin) でトークン取得
  const loginRes = await apiCall(baseUrl, "PasswordlessLogin", {
    MinimumPrivilegeLevel: "InitialAdmin",
  });
  const authToken = (loginRes as { data?: { authenticationToken?: string } }).data?.authenticationToken;
  if (!authToken) {
    throw new Error("Failed to obtain auth token from PasswordlessLogin");
  }

  // 3. ClaimServer でサーバークレーム
  try {
    await apiCall(baseUrl, "ClaimServer", {
      ServerName: serverLabel,
      AdminPassword: adminPassword,
    }, authToken);
  } catch (e) {
    // サーバーが既にクレーム済みの場合はエラーを無視
    console.log("ClaimServer result (may already be claimed):", e);
  }

  // 既にクレーム済みの場合は AdminPassword でログインし直す
  let token = authToken;
  try {
    const relogin = await apiCall(baseUrl, "PasswordLogin", {
      MinimumPrivilegeLevel: "Administrator",
      Password: adminPassword,
    });
    const newToken = (relogin as { data?: { authenticationToken?: string } }).data?.authenticationToken;
    if (newToken) token = newToken;
  } catch {
    // PasswordlessLogin のトークンがまだ有効ならそのまま使う
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

  // セッションからセーブ名を探す（saveName, sessionName 等の候補を試す）
  let saveName: string | undefined;
  if (sessions && sessions.length > 0) {
    const latest = sessions[0];
    saveName = (latest.saveName as string)
      || (latest.sessionName as string)
      || (latest.SaveName as string)
      || (latest.name as string);
    console.log("Latest session:", JSON.stringify(latest, null, 2));
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
  for (let i = 0; i < 30; i++) {
    const stateRes = await apiCall(baseUrl, "QueryServerState", {}, token);
    const serverState = (stateRes as { data?: { serverGameState?: { isGameRunning?: boolean } } }).data?.serverGameState;
    if (serverState?.isGameRunning) {
      console.log("Satisfactory server is running and game is loaded");
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error("Game did not start after LoadGame (timeout)");
}
