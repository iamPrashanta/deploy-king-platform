// A fresh database makes the admin change the seeded password at first sign-in. Do that, so every check can sign in.
import { call, login, setToken, PW } from "/t/lib.mjs";
const first = await call("m", "auth.login", { username: "admin", password: "Initial-Passw0rd-1" }, true);
if (first?.token) {
  setToken(first.token);
  await call("m", "auth.changePassword", { newPassword: PW });
}
const ok = await login();
console.log(ok?.token ? "admin ready" : "admin sign-in FAILED");
process.exit(ok?.token ? 0 : 1);
