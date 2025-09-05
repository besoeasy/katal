KATAL 

A download manager that is controlled by nostr bot, fully open source, uses NOSTR so almost cencorship free. created as a alternative for telearia (https://github.com/besoeasy/telearia).


Uses aria2 under the hood.
Fast and lightweight 
The files are avaiable over web at port 6799 feel free to map to whatever 

and also starts a samba SMB share at port 445 

the bot is avaiable on UI 6798 use it to setup inital account

built with full decenterlissation in mind, supports few torrent apis i could do without being sued. if you are creative it can be plugged to sonarr, plex, jellyfin, bitmagnet and other services easily but that is upto you to explore.





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