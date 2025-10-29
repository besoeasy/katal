#!/bin/bash

# Ensure SAVE_DIR exists
SAVE_DIR=$(bun -e "console.log(require('os').tmpdir() + '/katal')")

mkdir -p "$SAVE_DIR"

echo "Download directory: $SAVE_DIR"

# Generate random SMB credentials (simpler approach for non-root)
SMB_USER="katal$(shuf -i 1000-9999 -n 1)"
SMB_PASS=$(openssl rand -base64 12 | tr -d "=+/" | cut -c1-10)

# Save credentials for the bot to display
echo "$SMB_USER:$SMB_PASS" > "$SAVE_DIR/../smb_credentials.txt"

echo "SMB Credentials: $SMB_USER / $SMB_PASS"

sleep 2

# Create minimal smb.conf that works without root
# Use simple guest-only access since we can't create system users
cat >"$SAVE_DIR/../smb.conf" <<EOL
[global]
   map to guest = Bad User
   server min protocol = SMB2
   disable netbios = yes
   smb ports = 445
   log level = 1
   load printers = no
   printcap name = /dev/null
   disable spoolss = yes

[katal]
   comment = Katal downloads
   path = $SAVE_DIR
   read only = no
   guest ok = yes
   force user = $(id -un)
   browseable = yes
   create mask = 0664
   directory mask = 0775
EOL

# Set permissions for current user
chmod -R 0775 "$SAVE_DIR" 2>/dev/null || true

# Start Samba with custom config (non-root mode)
# Note: This may have limited functionality when not running as root
smbd --foreground --no-process-group --configfile="$SAVE_DIR/../smb.conf" --log-stdout &

sleep 5

aria2c --enable-rpc --rpc-listen-all --rpc-listen-port=6398 --listen-port=59123 \
  --enable-dht=true --enable-peer-exchange=true --seed-time=100 \
  --bt-tracker="udp://tracker.opentrackr.org:1337/announce,udp://open.demonii.com:1337/announce,udp://open.stealth.si:80/announce,udp://exodus.desync.com:6969/announce" &

sleep 5

# Trap signals and forward to child processes
trap 'kill $(jobs -p); exit 0' SIGTERM SIGINT

while true; do
   bun app.js &
   APP_PID=$!
   wait $APP_PID
   EXIT_CODE=$?
   
   # If we received a signal, don't restart
   if [ $EXIT_CODE -eq 143 ] || [ $EXIT_CODE -eq 130 ]; then
       echo "Received shutdown signal, exiting..."
       exit 0
   fi
   
   echo "Bot crashed with exit code $EXIT_CODE - restarting in 5 seconds..."
   sleep 7
done