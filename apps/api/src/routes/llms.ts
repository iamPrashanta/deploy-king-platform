import type { Request, Response } from "express";
import { TOOLS } from "../mcp/tools";
import { TLS_ENABLED } from "../config";

/**
 * GET /llms.txt — how an AI agent connects to and uses this Deploy King server.
 * Built from the live tool list so it never drifts from what /mcp serves.
 */
const SCOPE_TEXT: Record<string, string> = {
  read: "Read (any token)",
  deploy: "Deploy (deploy or full token)",
  full: "Delete (full token only)",
};

function panelUrl(req: Request) {
  const host = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  // The panel's proxy passes the host on; the scheme follows the platform's TLS setting when it doesn't say.
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() || (TLS_ENABLED ? "https" : "http");
  return host ? `${proto}://${host}` : "https://<your panel>";
}

export function llmsTxt(req: Request, res: Response) {
  const base = panelUrl(req);
  const mcp = `${base}/mcp`;
  const toolList = (["read", "deploy", "full"] as const)
    .map((scope) => `### ${SCOPE_TEXT[scope]}\n` + TOOLS.filter((t) => t.scope === scope).map((t) => `- \`${t.name}\`: ${t.description}`).join("\n"))
    .join("\n\n");

  const text = `# Deploy King

> Deploy King is a self-hosted platform that builds and runs web apps in containers on the user's own server. It checks a project before deploying, moves traffic only after a release passes its health check, asks questions when a deploy needs a decision, and has workflows and an MCP server for AI agents.

This server's panel: ${base}

## Connect (MCP)

- Endpoint: ${mcp}
- Transport: Streamable HTTP. POST JSON-RPC messages; responses are JSON. No sessions, no SSE stream.
- Auth: \`Authorization: Bearer dk_…\`. The user makes the token in the panel under **AI agents → New token** and chooses its access: read, deploy or full.
- If you have no token, ask the user to make one and add it to your MCP settings. Don't ask them to paste it into the chat if your client can store it.

Client setup (replace dk_… with the token):

\`\`\`
# Claude Code
claude mcp add --transport http deploy-king ${mcp} --header "Authorization: Bearer dk_…"

# Codex
export DEPLOY_KING_TOKEN=dk_…
codex mcp add deploy-king --url ${mcp} --bearer-token-env-var DEPLOY_KING_TOKEN
\`\`\`

Cursor (~/.cursor/mcp.json): \`{"mcpServers":{"deploy-king":{"url":"${mcp}","headers":{"Authorization":"Bearer dk_…"}}}}\`
VS Code (.vscode/mcp.json): \`{"servers":{"deploy-king":{"type":"http","url":"${mcp}","headers":{"Authorization":"Bearer dk_…"}}}}\`
Claude Desktop: use \`npx -y mcp-remote ${mcp} --header "Authorization:Bearer dk_…"\` as a stdio server.

## Tools

${toolList}

## Deploy a repository

1. \`check_repo\` with the repository URL. If the verdict is not deployable, tell the user what to fix and stop. If the repository holds several apps, the result lists \`appFolders\`: run check_repo again with \`rootDirectory\` set to the app's folder. Then \`check_fit\` (with the memory limit, if you will set one): if it is blocked, tell the user the reasons and what to change, and stop. A token cannot deploy past a block; only the server owner can, in the panel.
2. \`create_app\` with a short name, the repoUrl, the branch, the rootDirectory if you used one, the port check_repo found, and the variables it lists. Ask the user for real secret values; never invent them. Variables the build reads (NEXT_PUBLIC_*, VITE_* and similar are detected; list others in \`buildVariables\`) are also passed to the build.
3. \`wait_for_deploy\`. Repeat while the result is \`still_running\`.
4. If the result is \`needs_answer\`, read the question and its answers, choose one (ask the user if it is not obvious), call \`answer_deploy_question\`, then \`wait_for_deploy\` again.
5. When the result is \`live\`, give the user the URL.

To deploy an image instead (for example n8nio/n8n:latest), call \`create_app\` with image and port.

## Fix a failed deploy

1. \`wait_for_deploy\` or \`get_deploy_log\` shows the error and the end of the log.
2. Usual causes: the app listens on another port, it ran out of memory, a variable is missing, or the build command fails.
   An app whose status is \`crashing\` went live and then kept restarting: \`get_app\` shows the restart count and last output.
3. Fix the code or settings (set_env for variables), then \`deploy_app\`. For a crash after going live, read \`get_app_logs\`.
4. If the live release is broken and the user wants it back, \`rollback_app\`.

## Rules

- Ask the user before \`delete_app\`, before rolling back a live app, and before changing variables of a live app.
- Variable values are write-only. You cannot read them back; ask the user when you need one.
- Every call is shown to the user on the AI agents page. Limit: 120 calls a minute per token. Prefer \`wait_for_deploy\` to polling.
- A "not allowed" answer means the token's access level is too low. Tell the user which access is needed instead of retrying.

## Install Deploy King on a new server

Needs a Linux server (Ubuntu 22.04/24.04 or Debian 12) with root access and 2 GB of memory or more. Optional: a domain pointing at the server.

\`\`\`
git clone https://github.com/iamPrashanta/deploy-king-platform.git /opt/deploy-king-src
cd /opt/deploy-king-src
sudo bash scripts/install.sh --domain panel.example.com
\`\`\`

Run it only when the user asked you to install Deploy King on that server. Read the installer output; if it fails, stop and report the error rather than editing system files by hand. Afterwards the user opens the panel, sets the admin password, and makes a token under AI agents.

## Backups

The dbbkp CLI backs up MySQL, PostgreSQL and folders and restores them on a new server: https://github.com/iamPrashanta/dbbkp. The panel's Backup CLI page has install and recovery commands.
`;
  res.type("text/markdown; charset=utf-8").set("Cache-Control", "public, max-age=300").send(text);
}
