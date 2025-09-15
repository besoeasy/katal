# Use Bun official image instead of Node
FROM oven/bun:latest

# Install system dependencies
RUN apt-get update && \
  apt-get install -y --no-install-recommends \
  aria2 samba python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install with Bun
COPY package.json bun.lockb* ./
RUN bun install --production

# Copy the rest of the source code
COPY . .

# Expose the same ports
EXPOSE 445 6798 6799 59123/tcp 59123/udp

# Run your start script
CMD ["bash", "start.sh"]
