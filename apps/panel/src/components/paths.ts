/** Pages shown without the sidebar and header. */
export const isBarePath = (p: string) => p === "/login" || p === "/setup/password" || isOpenPath(p);

/** Pages anyone may open without signing in: accepting an invitation, asking for access, and setting up 2-step sign-in during sign-in. */
export const isOpenPath = (p: string) => p === "/signup" || p.startsWith("/invite/") || p === "/setup/two-step";

/** Where sign-in keeps the short-lived challenge between the password and the 2-step screens. Never a session. */
export const TWO_STEP_KEY = "dk.twoStepChallenge";
