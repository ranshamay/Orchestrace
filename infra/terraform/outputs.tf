output "ec2_public_ip" {
  description = "Public IPv4 address of compute instance."
  value       = aws_instance.compute.public_ip
}

output "ec2_public_dns" {
  description = "Public DNS name of compute instance."
  value       = aws_instance.compute.public_dns
}

output "deploy_private_key_path" {
  description = "Local path of generated SSH private key for GitHub Actions secret setup."
  value       = local_file.deploy_key_pem.filename
  sensitive   = true
}

output "cloudflare_pages_project" {
  description = "Cloudflare Pages project created for UI."
  value       = cloudflare_pages_project.ui.name
}