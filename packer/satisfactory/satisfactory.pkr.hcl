packer {
  required_plugins {
    amazon = {
      version = ">= 1.2.0"
      source  = "github.com/hashicorp/amazon"
    }
    ansible = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/ansible"
    }
  }
}

variable "region" {
  type    = string
  default = "ap-northeast-1"
}

variable "instance_type" {
  type    = string
  default = "t3.large"
}

source "amazon-ebs" "satisfactory" {
  region        = var.region
  instance_type = var.instance_type
  ami_name      = "satisfactory-{{timestamp}}"

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

  tags = {
    Name                 = "satisfactory-{{timestamp}}"
    discord-bot-managed  = "true"
    packer               = "true"
  }

  snapshot_tags = {
    Name                 = "satisfactory-{{timestamp}}"
    discord-bot-managed  = "true"
    packer               = "true"
  }
}

build {
  sources = ["source.amazon-ebs.satisfactory"]

  provisioner "ansible" {
    playbook_file = "ansible/playbook.yml"
    user          = "ubuntu"
  }
}
