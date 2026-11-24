#!/bin/bash
# copy every script from the repo (tests/local/env, checks, tools) into /t inside the test container.
# In the repo they are sorted into folders; in the container they sit side by side, so scripts can call each other as /t/<name>.
mkdir -p /t
for d in env checks tools; do cp /src/tests/local/$d/* /t/ 2>/dev/null; done
sed -i 's/\r$//' /t/*.sh /t/*.mjs /t/*.cjs /t/*.ts 2>/dev/null
ln -sfn /opt/shot /tmp/shot
echo "scripts: $(ls /t | wc -l)"
