#!/bin/bash
# build the three ZIP fixtures
set -e
rm -rf /tmp/z && mkdir -p /tmp/z/vite/proj /tmp/z/go /tmp/z/broken && cd /tmp/z
# a "front-end build" project: no start script, a build script, a known static framework in devDependencies
cat > vite/proj/package.json <<'J'
{ "name": "fixture-static-build", "private": true, "scripts": { "build": "node build.js" }, "devDependencies": { "vite": "*" } }
J
cat > vite/proj/build.js <<'J'
const fs = require("fs"); fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", "<h1>built by the pipeline at " + new Date().toISOString() + "</h1>");
J
sed -i 's/"vite": "\*"/"vite": "*"/' vite/proj/package.json
# keep the fixture fast: declare the framework but do not actually download it
node -e 'const p=require("/tmp/z/vite/proj/package.json"); p.devDependencies={}; p.dependencies={}; p.devDependencies["vite"]="file:./stub"; require("fs").writeFileSync("/tmp/z/vite/proj/package.json", JSON.stringify(p,null,2))'
mkdir -p vite/proj/stub && echo '{"name":"vite","version":"0.0.0"}' > vite/proj/stub/package.json
(cd vite && zip -qr ../vite.zip proj)   # wrapped in a top-level folder on purpose
cat > go/go.mod <<'J'
module fixture

go 1.22
J
cat > go/main.go <<'J'
package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "hello from go, FOO="+os.Getenv("FOO")) })
	http.ListenAndServe(":"+os.Getenv("PORT"), nil)
}
J
(cd go && zip -qr ../go.zip .)
cat > broken/package.json <<'J'
{ "name": "fixture-broken", "private": true, "scripts": { "start": "node -e \"console.error('boom: missing DATABASE_URL'); process.exit(1)\"" } }
J
(cd broken && zip -qr ../broken.zip .)
ls -la /tmp/z/*.zip | awk '{print $5, $9}'