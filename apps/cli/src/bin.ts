import { main } from "./main";

// Exit when the session is over, even if stdin is still open (input piped from another program).
main().then(() => process.exit(process.exitCode ?? 0));
