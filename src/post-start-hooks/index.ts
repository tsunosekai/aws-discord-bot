// 起動後フックのレジストリ
// 新しいゲームサーバー用フックを追加する場合はここに登録する

type PostStartHookFn = (
  host: string,
  serverLabel: string,
  hookConfig: Record<string, unknown>
) => Promise<void>;

const hooks = new Map<string, () => Promise<{ postStartHook: PostStartHookFn }>>();

// フック登録（dynamic import で遅延ロード）
hooks.set("satisfactory", () => import("./satisfactory.js"));

export async function runPostStartHook(
  hookName: string,
  host: string,
  serverLabel: string,
  hookConfig: Record<string, unknown>
): Promise<void> {
  const loader = hooks.get(hookName);
  if (!loader) {
    throw new Error(`Unknown post-start hook: "${hookName}"`);
  }
  const mod = await loader();
  await mod.postStartHook(host, serverLabel, hookConfig);
}

export function hasPostStartHook(hookName: string): boolean {
  return hooks.has(hookName);
}
