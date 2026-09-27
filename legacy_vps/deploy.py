import paramiko
import os
import sys

def main():
    # Force stdout encoding to UTF-8
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

    host = "65.20.78.237"
    port = 22
    username = "root"
    password = "C7(t3rVKRGaJox3C"
    
    local_dir = os.path.dirname(os.path.abspath(__file__))
    
    files_to_upload = {
        "mediamtx.yml": "/tmp/mediamtx.yml",
        "mediamtx.service": "/tmp/mediamtx.service",
        "index.html": "/tmp/streaming_index.html",
        "style.css": "/tmp/streaming_style.css",
        "app.js": "/tmp/streaming_app.js"
    }
    
    print("="*60)
    print(" STARTING REMOTE STREAMING DEPLOYMENT ")
    print("="*60)
    
    print(f"Connecting to remote VPS {host}:{port}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        ssh.connect(host, username=username, password=password, timeout=15)
        print("Connected successfully!")
        
        # Open SFTP channel
        print("Opening SFTP channel for file transfers...")
        sftp = ssh.open_sftp()
        
        for local_name, remote_path in files_to_upload.items():
            local_path = os.path.join(local_dir, local_name)
            if not os.path.exists(local_path):
                print(f"Error: Local file {local_path} not found!")
                sys.exit(1)
            print(f"Uploading local '{local_name}' to remote '{remote_path}'...")
            sftp.put(local_path, remote_path)
            
        sftp.close()
        print("File uploads completed successfully.\n")
        
        # Define remote command sequence
        commands = [
            # 1. Update dependencies
            ("Installing remote dependencies (tar, curl, python3)...", 
             "apt-get update && apt-get install -y curl tar python3"),
             
            # 2. Create system directories
            ("Creating deployment directories...", 
             "mkdir -p /opt/mediamtx /var/www/streaming"),
             
            # 3. Tune Linux kernel UDP/TCP socket buffers and enable BBR for high-bitrate 4K streaming
            ("Tuning Linux kernel network socket buffers and enabling TCP BBR...", 
             "cat << 'EOF' > /etc/sysctl.d/99-streaming.conf\nnet.core.rmem_max=26214400\nnet.core.wmem_max=26214400\nnet.ipv4.tcp_rmem=4096 87380 26214400\nnet.ipv4.tcp_wmem=4096 65536 26214400\nnet.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\nEOF\nsysctl -p /etc/sysctl.d/99-streaming.conf"),
             
            # 3. Download MediaMTX v1.19.1
            ("Downloading MediaMTX v1.19.1...", 
             "curl -L -o /tmp/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.19.1/mediamtx_v1.19.1_linux_amd64.tar.gz"),
             
            # 4. Extract MediaMTX binary
            ("Extracting MediaMTX binary to /opt/mediamtx...", 
             "tar -xzf /tmp/mediamtx.tar.gz -C /opt/mediamtx/"),
             
            # 5. Move configuration files to final directories
            ("Configuring MediaMTX and Systemd service...", 
             "cp /tmp/mediamtx.yml /opt/mediamtx/mediamtx.yml && cp /tmp/mediamtx.service /etc/systemd/system/mediamtx.service"),
             
            # 6. Move frontend files to /var/www/streaming/
            ("Deploying frontend files to /var/www/streaming...", 
             "cp /tmp/streaming_index.html /var/www/streaming/index.html && cp /tmp/streaming_style.css /var/www/streaming/style.css && cp /tmp/streaming_app.js /var/www/streaming/app.js && chmod -R 755 /var/www/streaming"),
             
            # 7. Configure Firewall (UFW)
            ("Opening TCP/UDP ports in UFW firewall (1935: RTMP, 8890: SRT Ingest, 8189: WebRTC Media)...", 
             "ufw allow 1935/tcp && ufw allow 8890/udp && ufw allow 8189/udp && ufw allow 8189/tcp && ufw reload"),
             
            # 8. Backup and edit Nginx config
            ("Modifying Nginx reverse proxy configuration...", 
             "python3 -c '\n"
             "import sys, re\n"
             "path = \"/etc/nginx/sites-available/default\"\n"
             "with open(path, \"r\") as f:\n"
             "    text = f.read()\n"
             "cleaned_text = re.sub(r\"\\s*location\\s+/streaming\\s*\\{[^}]*\\}\", \"\", text)\n"
             "cleaned_text = re.sub(r\"\\s*location\\s+/stream-api/\\s*\\{[^}]*\\}\", \"\", cleaned_text)\n"
             "snippet = \"\"\"\n"
             "    location /streaming {\n"
             "        alias /var/www/streaming/;\n"
             "        index index.html;\n"
             "        add_header Cache-Control \"no-cache, must-revalidate\";\n"
             "        gzip on;\n"
             "        gzip_types text/css application/javascript application/json image/svg+xml;\n"
             "        gzip_min_length 1024;\n"
             "        gzip_comp_level 5;\n"
             "        gzip_vary on;\n"
             "        try_files $uri $uri/ /streaming/index.html =404;\n"
             "    }\n\n"
             "    location /stream-api/ {\n"
             "        rewrite ^/stream-api/(.*)$ /$1 break;\n"
             "        proxy_pass http://127.0.0.1:8889;\n"
             "        proxy_redirect / /stream-api/;\n"
             "        proxy_set_header Host $host;\n"
             "        proxy_set_header X-Real-IP $remote_addr;\n"
             "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
             "        proxy_set_header X-Forwarded-Proto $scheme;\n"
             "        proxy_http_version 1.1;\n"
             "        proxy_set_header Upgrade $http_upgrade;\n"
             "        proxy_set_header Connection \"Upgrade\";\n"
             "        proxy_buffering off;\n"
             "        proxy_request_buffering off;\n"
             "        proxy_read_timeout 60s;\n"
             "        proxy_send_timeout 60s;\n"
             "    }\n\"\"\"\n"
             "idx = cleaned_text.find(\"location / {\")\n"
             "if idx == -1:\n"
             "    print(\"Error: Could not find \\\"location / {\\\" block in Nginx default file.\")\n"
             "    sys.exit(1)\n"
             "new_text = cleaned_text[:idx] + snippet + \"\\n\" + cleaned_text[idx:]\n"
             "with open(path, \"w\") as f:\n"
             "    f.write(new_text)\n"
             "print(\"Nginx configuration successfully updated.\")\n"
             "'"),
             
            # 9. Configure logrotate for MediaMTX logs
            ("Configuring logrotate for MediaMTX to prevent disk space exhaustion...", 
             "cat << 'EOF' > /etc/logrotate.d/mediamtx\n/var/log/mediamtx.log {\n    daily\n    rotate 7\n    compress\n    delaycompress\n    missingok\n    notifempty\n    copytruncate\n}\nEOF"),

            # 11. Reload Systemd and MediaMTX
            ("Activating and starting MediaMTX service...", 
             "systemctl daemon-reload && systemctl enable mediamtx && systemctl restart mediamtx"),
             
            # 12. Test and reload Nginx
            ("Testing and reloading Nginx server...", 
             "nginx -t && systemctl reload nginx"),
             
            # 13. Cleanup temporary upload files
            ("Cleaning up temporary upload files...", 
             "rm -f /tmp/mediamtx.tar.gz /tmp/mediamtx.yml /tmp/mediamtx.service /tmp/streaming_index.html /tmp/streaming_style.css /tmp/streaming_app.js")
        ]
        
        # Execute commands sequentially
        for description, cmd in commands:
            print("="*50)
            print(description)
            print(f"Executing: {cmd}")
            print("="*50)
            
            stdin, stdout, stderr = ssh.exec_command(cmd)
            
            # Read stdout and stderr in blocks
            out = stdout.read().decode('utf-8', errors='replace')
            err = stderr.read().decode('utf-8', errors='replace')
            
            if out:
                print(out)
            if err:
                print("STDERR/LOGS:")
                print(err)
            
            # Check exit status of critical commands
            channel = stdout.channel
            exit_status = channel.recv_exit_status()
            print(f"Command exit code: {exit_status}\n")
            if exit_status != 0 and "UFW not" not in err: # Allow warnings, but crash on hard failures
                print(f"ERROR: Command failed with exit code {exit_status}. Aborting deployment.")
                sys.exit(1)
                
        print("="*60)
        print(" DEPLOYMENT SUCCESSFULLY COMPLETED! ")
        print(f"Visit: https://rydius.in/streaming/")
        print("="*60)
        
    except Exception as e:
        print(f"Deployment failed: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        ssh.close()

if __name__ == "__main__":
    main()
