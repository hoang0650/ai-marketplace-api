#!/bin/sh
# Restrict sandbox egress: allow the public internet, block the host, private
# ranges, link-local/metadata and other docker networks. Idempotent; rules live
# in DOCKER-USER (Docker's sanctioned hook). Remove with: $0 --remove
set -eu
SUBNET=172.31.250.0/24
HOST_IP=${HOST_IP:-72.62.72.165}
RULES="
-s $SUBNET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
-s $SUBNET -d $HOST_IP -j DROP
-s $SUBNET -d 10.0.0.0/8 -j DROP
-s $SUBNET -d 172.16.0.0/12 -j DROP
-s $SUBNET -d 192.168.0.0/16 -j DROP
-s $SUBNET -d 169.254.0.0/16 -j DROP
-s $SUBNET -d 100.64.0.0/10 -j DROP
-s $SUBNET -p tcp --dport 25 -j DROP
"
echo "$RULES" | while read -r r; do
  [ -z "$r" ] && continue
  if [ "${1:-}" = "--remove" ]; then
    iptables -D DOCKER-USER $r 2>/dev/null || true
  else
    iptables -C DOCKER-USER $r 2>/dev/null || iptables -I DOCKER-USER $r
  fi
done
# INPUT: sandboxes must not reach host services through the bridge gateway IP.
if [ "${1:-}" = "--remove" ]; then
  iptables -D INPUT -i aim-sbx0 -j DROP 2>/dev/null || true
else
  iptables -C INPUT -i aim-sbx0 -j DROP 2>/dev/null || iptables -I INPUT -i aim-sbx0 -j DROP
fi
