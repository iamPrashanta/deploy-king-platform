#!/bin/bash
for d in "$@"; do
  code=$(curl -s -m 8 -o /tmp/out -w '%{http_code}' -H "Host: $d" http://dbbkp-check-traefik/)
  echo "$d $code $(head -c 70 /tmp/out | tr '\n' ' ')"
done