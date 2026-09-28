import paramiko
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

host, user, pw = "65.20.78.237", "root", "C7(t3rVKRGaJox3C"

cmds = [
    ("SERVICES", "systemctl is-active mediamtx nginx; echo '---'; uptime"),
    ("CPU/MEM", "ps -o %cpu,%mem,etime,comm -p $(pgrep -d, mediamtx) 2>/dev/null; free -m | head -2"),
    ("MEDIAMTX PATHS API", "curl -s --max-time 3 http://127.0.0.1:8888/v3/paths | head -c 1200; echo"),
    ("MEDIAMTX LOG TAIL (errors/warnings)", "grep -E 'ERR|WARN|drop|queue|timeout' /var/log/mediamtx.log | tail -n 30; echo '=== last 15 lines ==='; tail -n 15 /var/log/mediamtx.log"),
    ("DEPLOYED FILE MTIMES", "ls -la --time-style=full-iso /var/www/streaming/ 2>/dev/null"),
    ("SYSCTL", "sysctl net.core.rmem_max net.core.wmem_max net.ipv4.tcp_congestion_control 2>/dev/null"),
    ("NGINX GZIP", "grep -E '^\\s*gzip' /etc/nginx/nginx.conf | head -8"),
]

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh.connect(host, username=user, password=pw, timeout=10)
    for label, cmd in cmds:
        print(f"\n{'='*18} {label} {'='*18}")
        stdin, stdout, stderr = ssh.exec_command(cmd, timeout=15)
        out = stdout.read().decode('utf-8', errors='replace').strip()
        err = stderr.read().decode('utf-8', errors='replace').strip()
        if out: print(out)
        if err: print("[stderr]", err)
finally:
    ssh.close()
print("\nDIAGNOSTICS COMPLETE")
