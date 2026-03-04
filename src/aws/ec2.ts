import {
  EC2Client,
  DescribeInstancesCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeImagesCommand,
  CreateImageCommand,
  DeregisterImageCommand,
  DescribeSnapshotsCommand,
  DeleteSnapshotCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  DescribeVpcsCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStatusOk,
  waitUntilImageAvailable,
} from "@aws-sdk/client-ec2";

const MANAGED_TAG_KEY = "discord-bot-managed";
const MANAGED_TAG_VALUE = "true";

// リージョンごとの EC2Client キャッシュ
const clientCache = new Map<string, EC2Client>();

function getClient(region: string): EC2Client {
  let client = clientCache.get(region);
  if (!client) {
    client = new EC2Client({ region });
    clientCache.set(region, client);
  }
  return client;
}

// --- Instance operations ---

export interface Ec2Instance {
  instanceId: string;
  label: string;
  publicIp: string;
  state: string;
  instanceType: string;
  launchTime?: Date;
}

export async function listInstances(region: string): Promise<Ec2Instance[]> {
  const client = getClient(region);
  const result = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${MANAGED_TAG_KEY}`, Values: [MANAGED_TAG_VALUE] },
        { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped"] },
      ],
    })
  );

  const instances: Ec2Instance[] = [];
  for (const reservation of result.Reservations || []) {
    for (const inst of reservation.Instances || []) {
      const nameTag = inst.Tags?.find((t) => t.Key === "Name");
      instances.push({
        instanceId: inst.InstanceId || "",
        label: nameTag?.Value || "",
        publicIp: inst.PublicIpAddress || "",
        state: inst.State?.Name || "",
        instanceType: inst.InstanceType || "",
        launchTime: inst.LaunchTime,
      });
    }
  }
  return instances;
}

export async function findInstanceByLabel(
  region: string,
  label: string
): Promise<Ec2Instance | undefined> {
  const instances = await listInstances(region);
  return instances.find(
    (i) => i.label === label && (i.state === "running" || i.state === "pending")
  );
}

export interface LaunchOptions {
  region: string;
  amiId: string;
  instanceType: string;
  label: string;
  securityGroupId: string;
  keyPairName: string;
  rootVolumeSize?: number;
  spot?: boolean;
}

export async function launchInstanceFromAmi(
  options: LaunchOptions
): Promise<Ec2Instance> {
  const client = getClient(options.region);

  const params: RunInstancesCommand["input"] = {
    ImageId: options.amiId,
    InstanceType: options.instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    KeyName: options.keyPairName,
    SecurityGroupIds: [options.securityGroupId],
    TagSpecifications: [
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: options.label },
          { Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE },
        ],
      },
    ],
  };

  if (options.rootVolumeSize) {
    params.BlockDeviceMappings = [
      {
        DeviceName: "/dev/sda1",
        Ebs: {
          VolumeSize: options.rootVolumeSize,
          VolumeType: "gp3",
          DeleteOnTermination: true,
        },
      },
    ];
  }

  if (options.spot) {
    params.InstanceMarketOptions = {
      MarketType: "spot",
      SpotOptions: {
        SpotInstanceType: "one-time",
      },
    };
  }

  const result = await client.send(new RunInstancesCommand(params));
  const inst = result.Instances?.[0];
  if (!inst) {
    throw new Error("インスタンスの作成に失敗しました");
  }

  return {
    instanceId: inst.InstanceId || "",
    label: options.label,
    publicIp: inst.PublicIpAddress || "",
    state: inst.State?.Name || "pending",
    instanceType: inst.InstanceType || "",
    launchTime: inst.LaunchTime,
  };
}

export async function terminateInstance(
  region: string,
  instanceId: string
): Promise<void> {
  const client = getClient(region);
  await client.send(
    new TerminateInstancesCommand({ InstanceIds: [instanceId] })
  );
}

export async function waitForInstanceReady(
  region: string,
  instanceId: string,
  timeoutSeconds: number = 600
): Promise<Ec2Instance> {
  const client = getClient(region);

  await waitUntilInstanceRunning(
    { client, maxWaitTime: timeoutSeconds },
    { InstanceIds: [instanceId] }
  );

  await waitUntilInstanceStatusOk(
    { client, maxWaitTime: timeoutSeconds },
    { InstanceIds: [instanceId] }
  );

  // インスタンス情報を再取得してIPアドレスを取得
  const result = await client.send(
    new DescribeInstancesCommand({ InstanceIds: [instanceId] })
  );
  const inst = result.Reservations?.[0]?.Instances?.[0];
  if (!inst) {
    throw new Error("インスタンスが見つかりません");
  }

  const nameTag = inst.Tags?.find((t) => t.Key === "Name");
  return {
    instanceId: inst.InstanceId || "",
    label: nameTag?.Value || "",
    publicIp: inst.PublicIpAddress || "",
    state: inst.State?.Name || "",
    instanceType: inst.InstanceType || "",
    launchTime: inst.LaunchTime,
  };
}

// --- AMI operations ---

export interface AmiInfo {
  amiId: string;
  name: string;
  state: string;
  creationDate: string;
}

export async function findAmisByPrefix(
  region: string,
  prefix: string
): Promise<AmiInfo[]> {
  const client = getClient(region);
  const result = await client.send(
    new DescribeImagesCommand({
      Owners: ["self"],
      Filters: [
        { Name: "name", Values: [`${prefix}*`] },
        { Name: `tag:${MANAGED_TAG_KEY}`, Values: [MANAGED_TAG_VALUE] },
      ],
    })
  );

  const amis: AmiInfo[] = (result.Images || []).map((img) => ({
    amiId: img.ImageId || "",
    name: img.Name || "",
    state: img.State || "",
    creationDate: img.CreationDate || "",
  }));

  // 作成日降順
  amis.sort((a, b) => b.creationDate.localeCompare(a.creationDate));
  return amis;
}

export async function createAmi(
  region: string,
  instanceId: string,
  name: string
): Promise<string> {
  const client = getClient(region);
  const result = await client.send(
    new CreateImageCommand({
      InstanceId: instanceId,
      Name: name,
      NoReboot: true,
      TagSpecifications: [
        {
          ResourceType: "image",
          Tags: [
            { Key: "Name", Value: name },
            { Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE },
          ],
        },
        {
          ResourceType: "snapshot",
          Tags: [
            { Key: "Name", Value: name },
            { Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE },
          ],
        },
      ],
    })
  );

  const amiId = result.ImageId;
  if (!amiId) {
    throw new Error("AMI の作成に失敗しました");
  }
  return amiId;
}

export async function deregisterAmi(
  region: string,
  amiId: string
): Promise<void> {
  const client = getClient(region);

  // AMI に関連するスナップショットを取得
  const imageResult = await client.send(
    new DescribeImagesCommand({ ImageIds: [amiId] })
  );
  const image = imageResult.Images?.[0];
  const snapshotIds: string[] = [];
  if (image?.BlockDeviceMappings) {
    for (const bdm of image.BlockDeviceMappings) {
      if (bdm.Ebs?.SnapshotId) {
        snapshotIds.push(bdm.Ebs.SnapshotId);
      }
    }
  }

  // AMI を登録解除
  await client.send(new DeregisterImageCommand({ ImageId: amiId }));

  // 関連スナップショットを削除
  for (const snapshotId of snapshotIds) {
    try {
      await client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
    } catch (error) {
      console.error(`スナップショット削除エラー (${snapshotId}):`, error);
    }
  }
}

export async function waitForAmiReady(
  region: string,
  amiId: string,
  timeoutSeconds: number = 1800
): Promise<void> {
  const client = getClient(region);
  await waitUntilImageAvailable(
    { client, maxWaitTime: timeoutSeconds },
    { ImageIds: [amiId] }
  );
}

// --- Security Group operations ---

export async function ensureSecurityGroup(
  region: string,
  name: string,
  ports: number[]
): Promise<string> {
  const client = getClient(region);
  const sgName = `discord-bot-${name}`;

  // 既存の SG を検索
  try {
    const existing = await client.send(
      new DescribeSecurityGroupsCommand({
        Filters: [{ Name: "group-name", Values: [sgName] }],
      })
    );

    if (existing.SecurityGroups && existing.SecurityGroups.length > 0) {
      const sg = existing.SecurityGroups[0];
      const sgId = sg.GroupId!;

      // 既存のインバウンドルールを削除
      if (sg.IpPermissions && sg.IpPermissions.length > 0) {
        await client.send(
          new RevokeSecurityGroupIngressCommand({
            GroupId: sgId,
            IpPermissions: sg.IpPermissions,
          })
        );
      }

      // 新しいルールを追加
      await authorizeIngressRules(client, sgId, ports);
      return sgId;
    }
  } catch (error: any) {
    if (error.Code !== "InvalidGroup.NotFound") {
      throw error;
    }
  }

  // デフォルト VPC の ID を取得
  const vpcs = await client.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: "is-default", Values: ["true"] }],
    })
  );
  const vpcId = vpcs.Vpcs?.[0]?.VpcId;

  // 新しい SG を作成
  const createResult = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: sgName,
      Description: `Security group for ${name} (managed by discord-bot)`,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: "security-group",
          Tags: [
            { Key: "Name", Value: sgName },
            { Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE },
          ],
        },
      ],
    })
  );

  const sgId = createResult.GroupId!;
  await authorizeIngressRules(client, sgId, ports);
  return sgId;
}

async function authorizeIngressRules(
  client: EC2Client,
  sgId: string,
  ports: number[]
): Promise<void> {
  const ipPermissions = [];

  // ゲームポート: 0.0.0.0/0 (TCP + UDP)
  for (const port of ports) {
    ipPermissions.push(
      {
        IpProtocol: "tcp",
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: "0.0.0.0/0", Description: `Game port ${port} TCP` }],
      },
      {
        IpProtocol: "udp",
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: "0.0.0.0/0", Description: `Game port ${port} UDP` }],
      }
    );
  }

  // SSH: ボットの IP に限定
  const botIp = await getBotPublicIp();
  ipPermissions.push({
    IpProtocol: "tcp",
    FromPort: 22,
    ToPort: 22,
    IpRanges: [{ CidrIp: `${botIp}/32`, Description: "SSH from bot" }],
  });

  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: sgId,
      IpPermissions: ipPermissions,
    })
  );
}

async function getBotPublicIp(): Promise<string> {
  const services = [
    "https://checkip.amazonaws.com",
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
  ];

  for (const url of services) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const ip = (await response.text()).trim();
        if (ip) return ip;
      }
    } catch {
      continue;
    }
  }

  throw new Error("ボットのパブリック IP を取得できませんでした");
}
