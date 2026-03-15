packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

source "amazon-ebs" "minecraft-bedrock" {
  region        = var.region
  instance_type = var.instance_type
  ami_name      = "minecraft-bedrock-{{timestamp}}"

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    most_recent = true
    owners      = ["099720109477"] # Canonical
  }

  ssh_username = "ubuntu"

  aws_polling {
    delay_seconds = 30
    max_attempts  = 60
  }

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 10
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name                = "minecraft-bedrock-{{timestamp}}"
    discord-bot-managed = "true"
    packer              = "true"
  }

  snapshot_tags = {
    Name                = "minecraft-bedrock-{{timestamp}}"
    discord-bot-managed = "true"
    packer              = "true"
  }
}

build {
  sources = ["source.amazon-ebs.minecraft-bedrock"]

  provisioner "shell-local" {
    inline = [
      "echo 'Downloading Minecraft Bedrock server locally...'",
      "curl -L -o bedrock-server.zip 'https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.3.1.zip'"
    ]
  }

  provisioner "file" {
    source      = "bedrock-server.zip"
    destination = "/tmp/bedrock-server.zip"
  }

  provisioner "shell" {
    script = "./provision.sh"
  }

  provisioner "shell-local" {
    inline = ["rm -f bedrock-server.zip"]
  }
}
