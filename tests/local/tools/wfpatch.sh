#!/bin/bash
# start the UI check from an empty list and report which URLs 404
f=/t/wf.mjs
grep -q 'automations.list' $f || sed -i 's|^const auth = await login("admin", PW);|const auth = await login("admin", PW);\nfor (const w of (await call("q", "automations.list")) ?? []) await call("m", "automations.delete", { id: w.id });|' $f
grep -q 'r.status() === 404' $f || sed -i 's|  page.on("dialog", (d) => d.accept());|  page.on("dialog", (d) => d.accept());\n  page.on("response", (r) => r.status() === 404 \&\& errors.push("404 " + r.url()));|' $f
grep -n 'automations.list\|404' $f
