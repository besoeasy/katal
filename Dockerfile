# Use Bun official image instead of Node
FROM oven/bun:latest

# Install system dependencies including tini for proper signal handling
RUN apt-get update && apt-get install -y aria2 samba openssl tini
RUN apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install with Bun
COPY package.json bun.lockb* ./
RUN bun install

# Copy the rest of the source code
COPY . .

# Expose the same ports
EXPOSE 445 6798 6799 59123/tcp 59123/udp

# Use tini as init system to properly handle signals
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run your start script
CMD ["bash", "start.sh"]