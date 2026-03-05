# AWS Discord Bot

Discord からゲームサーバー（EC2 インスタンス）を管理する Bot。
AMI からインスタンスを起動し、セーブデータを自動でアップロード/ダウンロードする。

## 仕組み

```
起動: AMI → EC2起動 → セーブデータアップロード → サービス起動 → (起動後フック)
停止: サービス停止 → セーブデータダウンロード → EC2削除
```

- インスタンスは毎回作り直し（使わないときはコストゼロ）
- セーブデータは VPS に保持（過去 N 世代分、デフォルト3）
- AMI は Packer で事前にビルド

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数

`.env` を作成:

```env
# Discord
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-client-id
DISCORD_GUILD_ID=your-default-guild-id
ALLOWED_ROLE_NAME=Server Manager  # 空ならロール制限なし

# AWS
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_REGION=ap-northeast-1
AWS_KEY_PAIR_NAME=your-key-pair-name

# SSH（EC2 へのセーブデータ転送用）
SSH_PRIVATE_KEY_PATH=/path/to/private-key

# リマインダー（稼働中サーバーの通知、省略可）
REMINDER_TIME=21:00
REMINDER_CHANNEL_ID=channel-id

# ファイルサーバー（セーブデータのダウンロードリンク用）
FILE_SERVER_PORT=8081
FILE_SERVER_BASE_URL=https://example.com/files
FILE_DOWNLOAD_DIR=/path/to/downloads
FILE_RETENTION=3  # 保持する世代数
```

### 3. サーバー設定

`servers.json` を作成（`servers.example.json` を参考に）:

```json
{
  "adminGuilds": ["管理用DiscordサーバーID"],
  "servers": {
    "my-server": {
      "label": "表示名",
      "region": "ap-northeast-1",
      "instanceType": "t3.medium",
      "amiPrefix": "my-server-",
      "description": "サーバーの説明",
      "allowedGuilds": ["DiscordサーバーID"],
      "sshUser": "ubuntu",
      "stopCommand": "sudo systemctl stop myservice",
      "startCommand": "sudo systemctl start myservice",
      "securityGroupPorts": [25565],
      "rootVolumeSize": 10,
      "downloadableFiles": {
        "world": {
          "path": "/path/to/world",
          "description": "ワールドデータ",
          "type": "directory"
        }
      }
    }
  }
}
```

**設定項目:**

| 項目 | 説明 |
|---|---|
| `adminGuilds` | 全サーバーが見える管理用ギルドID |
| `allowedGuilds` | このサーバーを見せるギルドID（空配列 = 全公開） |
| `amiPrefix` | AMI 名のプレフィックス（最新の AMI を自動選択） |
| `securityGroupPorts` | 開放するポート（22 は自動追加） |
| `postStartHook` | 起動後に実行するフック名（例: `satisfactory`） |
| `hookConfig` | フックに渡す設定 |
| `spot` | `true` でスポットインスタンスを使用 |

### 4. コマンド登録

```bash
npm run register
```

`servers.json` の `allowedGuilds` と `adminGuilds` に含まれる全ギルドに自動登録される。

### 5. 起動

```bash
# 開発
npm run dev

# 本番
npm run build
npm start
```

## Discord コマンド

| コマンド | 説明 |
|---|---|
| `/server start <name>` | AMI からサーバーを起動 |
| `/server stop <name>` | セーブデータを保存してサーバーを停止 |
| `/server status [name]` | サーバーの状態を確認（省略で全サーバー） |
| `/server list` | 利用可能なサーバー一覧 |
| `/server files <name>` | 保存済みセーブデータの一覧 |

## AMI のビルド

[Packer](https://www.packer.io/) を使用。`packer/` 以下にゲームごとのテンプレートがある。

```bash
cd packer/minecraft-java
packer init .
packer build .
```

### Bedrock 版の注意

minecraft.net がデフォルトの curl をブロックするため、Bedrock の AMI ビルドは2段階:

1. ローカルで zip をダウンロード（ブラウザ User-Agent が必要）
2. Packer の `file` provisioner で EC2 にアップロード

```bash
cd packer/minecraft-bedrock
curl --http1.1 -L -A "Mozilla/5.0" -o bedrock-server.zip \
  'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-X.XX.X.X.zip'
packer init .
packer build .
rm bedrock-server.zip
```

## 対応ゲーム

| ゲーム | AMI プレフィックス | 備考 |
|---|---|---|
| Satisfactory | `satisfactory-` | 起動後フックで自動クレーム・セーブロード |
| Minecraft Java | `minecraft-java-` | |
| Minecraft 統合版 | `minecraft-bedrock-` | |

## ディレクトリ構成

```
src/
  index.ts              # エントリーポイント
  config.ts             # サーバー設定の読み込み
  file-server.ts        # セーブデータ配信サーバー
  reminder.ts           # 稼働中サーバーのリマインダー
  aws/ec2.ts            # EC2 操作（起動・停止・AMI検索）
  sftp/client.ts        # SFTP でのファイル転送
  discord/
    bot.ts              # Discord Bot 本体
    commands/server.ts  # /server コマンド
  post-start-hooks/
    index.ts            # フックのディスパッチ
    satisfactory.ts     # Satisfactory 用フック
packer/
  satisfactory/         # Satisfactory AMI テンプレート
  minecraft-java/       # Minecraft Java AMI テンプレート
  minecraft-bedrock/    # Minecraft Bedrock AMI テンプレート
```
