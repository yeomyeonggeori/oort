output "compute" {
  description = "Which fork was requested."
  value       = var.compute
}

output "public_ip" {
  description = "IPv4 for the DNS A record (human approval point 4). Lightsail static IP or EC2 EIP."
  value = local.is_lightsail ? aws_lightsail_static_ip.oort[0].ip_address : (
    local.is_ec2 ? aws_eip.oort[0].public_ip : null
  )
}

output "ssh_user" {
  description = "SSH user on the Ubuntu LTS blueprint/AMI."
  value       = "ubuntu"
}

output "data_mount" {
  description = "Where cloud-init mounts the extra disk (docker data-root lives under this)."
  value       = "/data"
}

output "resource_count_hint" {
  description = "Show this count to the operator before apply (approval point 2). Lightsail=7, EC2=6."
  value       = local.is_lightsail ? 7 : 6
}
