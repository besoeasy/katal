#!/bin/bash

# Ensure SAVE_DIR exists
SAVE_DIR=$(bun -e "console.log(require('os').tmpdir() + '/katal')")

mkdir -p "$SAVE_DIR"

echo "Download directory: $SAVE_DIR"

# Generate random SMB credentials
SMB_USER="katal$(shuf -i 1000-9999 -n 1)"
SMB_PASS=$(openssl rand -base64 12 | tr -d "=+/" | cut -c1-10)

# Save credentials in a location we can write to (inside SAVE_DIR parent)
CRED_FILE="$SAVE_DIR/../smb_credentials.txt"
echo "$SMB_USER:$SMB_PASS" > "$CRED_FILE"

echo "SMB Credentials: $SMB_USER / $SMB_PASS"
echo "Credentials saved to: $CRED_FILE"

# Create SMB config in a writable location
SMB_CONF="$SAVE_DIR/../smb.conf"
SMB_LOG_DIR="$SAVE_DIR/../samba_logs"

# Create log directory that we own
mkdir -p "$SMB_LOG_DIR"

cat >"$SMB_CONF" <<EOL
[global]
   workgroup = WORKGROUP
   server string = Katal SMB Server
   security = user
   map to guest = Bad User
   guest account = nobody
   
   # Use writable log directory
   log file = $SMB_LOG_DIR/log.%m
   max log size = 50
   log level = 1
   
   # Disable features that need root
   load printers = no
   printcap name = /dev/null
   disable spoolss = yes
   
   # Network settings
   server min protocol = SMB2
   disable netbios = yes
   smb ports = 445
   
   # Performance
   socket options = TCP_NODELAY IPTOS_LOWDELAY SO_RCVBUF=131072 SO_SNDBUF=131072
   read raw = yes
   write raw = yes
   
   # Avoid privilege operations
   passdb backend = smbpasswd
   smb passwd file = $SAVE_DIR/../smbpasswd

[katal]
   comment = Katal downloads (guest read-only)
   path = $SAVE_DIR
   read only = yes
   guest ok = yes
   browseable = yes
   force user = $(id -un)
   force group = $(id -gn)
   create mask = 0664
   directory mask = 0775

[katal-rw]
   comment = Katal downloads (full access)
   path = $SAVE_DIR
   read only = no
   guest ok = no
   valid users = $SMB_USER
   browseable = yes
   force user = $(id -un)
   force group = $(id -gn)
   create mask = 0664
   directory mask = 0775
EOL

echo "SMB config created at: $SMB_CONF"

# Set permissions for current user
chmod -R 0775 "$SAVE_DIR" 2>/dev/null || true

# Create smbpasswd file manually (since we can't use smbpasswd command without root)
# We'll just rely on guest access since we can't create users as non-root
echo "Note: Running as non-root user ($(id -un):$(id -gn))"
echo "SMB will use guest-only access due to privilege restrictions"

# Start Samba with custom config (this may fail or have limited functionality as non-root)
echo "Starting Samba server..."
smbd --foreground --no-process-group --configfile="$SMB_CONF" --log-stdout 2>&1 &
SMBD_PID=$!

# Check if Samba started successfully
sleep 2
if ps -p $SMBD_PID > /dev/null; then
    echo "Samba started successfully (PID: $SMBD_PID)"
else
    echo "WARNING: Samba may have failed to start (privilege restrictions)"
    echo "File access will be available via HTTP on port $SERVERPORT"
fi

sleep 3

# Start aria2c
echo "Starting aria2c..."
aria2c --enable-rpc --rpc-listen-all --rpc-listen-port=6398 --listen-port=59123 \
  --enable-dht=true --enable-peer-exchange=true --seed-time=100 \
  --bt-tracker="udp://tracker.opentrackr.org:1337/announce,udp://open.demonii.com:1337/announce,udp://open.stealth.si:80/announce,udp://exodus.desync.com:6969/announce" 2>&1 &
ARIA_PID=$!

sleep 3

if ps -p $ARIA_PID > /dev/null; then
    echo "aria2c started successfully (PID: $ARIA_PID)"
else
    echo "ERROR: aria2c failed to start"
    exit 1
fi

# Trap signals and forward to child processes
cleanup() {
    echo "Received shutdown signal, cleaning up..."
    
    # Kill all child processes
    if [ ! -z "$APP_PID" ] && ps -p $APP_PID > /dev/null 2>&1; then
        echo "Stopping app (PID: $APP_PID)..."
        kill -TERM $APP_PID 2>/dev/null || true
        wait $APP_PID 2>/dev/null || true
    fi
    
    if ps -p $ARIA_PID > /dev/null 2>&1; then
        echo "Stopping aria2c (PID: $ARIA_PID)..."
        kill -TERM $ARIA_PID 2>/dev/null || true
    fi
    
    if ps -p $SMBD_PID > /dev/null 2>&1; then
        echo "Stopping Samba (PID: $SMBD_PID)..."
        kill -TERM $SMBD_PID 2>/dev/null || true
    fi
    
    # Wait for processes to exit
    sleep 2
    
    echo "Cleanup complete, exiting..."
    exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# Start the main application
echo "Starting Katal bot..."
while true; do
   bun app.js &
   APP_PID=$!
   echo "App started (PID: $APP_PID)"
   
   # Wait for the app process
   wait $APP_PID
   EXIT_CODE=$?
   
   # If we received a signal (exit codes 128+signal), don't restart
   if [ $EXIT_CODE -eq 143 ] || [ $EXIT_CODE -eq 130 ] || [ $EXIT_CODE -ge 128 ]; then
       echo "Received shutdown signal (exit code: $EXIT_CODE), exiting..."
       cleanup
       exit 0
   fi
   
   echo "Bot crashed with exit code $EXIT_CODE - restarting in 7 seconds..."
   sleep 7
done