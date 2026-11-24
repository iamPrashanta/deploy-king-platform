#!/bin/bash
# create a non-admin user straight in the database
cd /work/packages/db && node -e '
const postgres = require("postgres"); const bcrypt = require("bcryptjs");
(async () => {
  const sql = postgres("postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel");
  const hash = await bcrypt.hash("Bob-Passw0rd-12345", 10);
  await sql`insert into users (email, username, password_hash, role, must_change_password) values (${"bob@test.local"}, ${"bob"}, ${hash}, ${"user"}, false) on conflict do nothing`;
  console.log("user bob ready"); await sql.end();
})();
'