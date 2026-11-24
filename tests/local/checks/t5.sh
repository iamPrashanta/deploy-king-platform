#!/bin/bash
# project-check fixtures
set -e
rm -rf /tmp/a && mkdir -p /tmp/a/cli/lib /tmp/a/express /tmp/a/static /tmp/a/lib /tmp/a/next /tmp/a/laravel/public
cd /tmp/a
printf '#!/bin/bash\necho backup\n' > cli/dbbkp.sh; printf 'x\n' > cli/lib/mysql.sh; printf 'y\n' > cli/lib/pg.sh; echo '# dbbkp' > cli/README.md; echo MIT > cli/LICENSE
cat > express/package.json <<'J'
{ "name": "api", "scripts": { "start": "node server.js" }, "dependencies": { "express": "^4", "pg": "^8", "ioredis": "^5" } }
J
echo '{}' > express/package-lock.json
printf 'const app = require("express")();\napp.get("/", (q, r) => r.send("hi"));\napp.listen(8080);\n' > express/server.js
printf '# config\nPORT=3000\nDATABASE_URL=postgres://user:pass@localhost:5432/app\nJWT_SECRET=\nSTRIPE_SECRET_KEY=your_stripe_key_here\nREDIS_URL=redis://localhost:6379\nAPP_NAME="My API"\n' > express/.env.example
echo 'SECRET=1' > express/.env
echo '<h1>hi</h1>' > static/index.html
echo '{ "name": "left-pad", "main": "index.js", "types": "index.d.ts", "bin": { "lp": "cli.js" } }' > lib/package.json
echo 'module.exports = 1' > lib/index.js
cat > next/package.json <<'J'
{ "name": "web", "scripts": { "dev": "next dev", "build": "next build", "start": "next start" }, "dependencies": { "next": "15.0.0", "react": "18", "@prisma/client": "5" }, "engines": { "node": ">=20" } }
J
echo 'lockfileVersion: 9' > next/pnpm-lock.yaml
mkdir -p next/prisma && printf 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n' > next/prisma/schema.prisma
printf 'DATABASE_URL=\nNEXTAUTH_SECRET=\nNEXTAUTH_URL=http://localhost:3000\nGITHUB_CLIENT_ID=\n' > next/.env.example
echo '{"require":{"laravel/framework":"^11"}}' > laravel/composer.json; touch laravel/artisan; echo '<?php' > laravel/public/index.php
printf 'APP_KEY=\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PASSWORD=\n' > laravel/.env.example
cd /work/apps/api && cat > ./_run_analyze.ts <<'J'
import { analyzeProject } from "@dbbkp/buildplan";
for (const d of ["cli", "express", "static", "lib", "next", "laravel"]) {
  const r = analyzeProject("/tmp/a/" + d);
  console.log(`\n=== ${d}: ${r.verdict} | ${r.summary}`);
  console.log("  facts:", r.facts.map((f) => `${f.label}=${f.value}`).join("; "));
  for (const c of r.checks) console.log(`  [${c.level}] ${c.title}${c.detail ? " - " + c.detail.slice(0, 110) : ""}`);
  for (const q of r.questions) console.log(`  ? ${q.id}: ${q.title} (default ${q.default})`);
  if (r.env.length) console.log("  env:", r.env.map((e) => `${e.key}${e.placeholder ? (e.canGenerate ? "[gen]" : "[need]") : ""}${e.platform ? "[platform]" : ""}`).join(" "));
}
J
npx tsx ./_run_analyze.ts; rm -f ./_run_analyze.ts
