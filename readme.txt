docker run -d \
  --name katal \
  --restart unless-stopped \
  -p 6798:6798 \
  -p 6799:6799 \
  -p 445:445 \
  -p 6888:6888/tcp \
  -p 6888:6888/udp \
  -v katal-data:/tmp/katal \
  -e NSEC=nsec16aku93935fxtnw7ukrnmygy0zmwtwn2a5ntqypl2nvex05mrh85qeu54v7\
  ghcr.io/besoeasy/katal:test