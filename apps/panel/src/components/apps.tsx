import { GitBranch, Package, Upload } from "lucide-react";

export function appUrl(domain: string, info?: { tls: boolean; publicHttpPort: number } | null) {
  if (!info) return `http://${domain}`;
  const scheme = info.tls ? "https" : "http";
  const port = !info.tls && info.publicHttpPort && info.publicHttpPort !== 80 ? `:${info.publicHttpPort}` : "";
  return `${scheme}://${domain}${port}`;
}

export function sourceLabel(s: any) {
  if (s.source === "image") return { icon: <Package size={13} />, text: s.image };
  if (s.source === "git") return { icon: <GitBranch size={13} />, text: `${(s.repoUrl || "").replace(/^https:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "")} · ${s.branch}` };
  return { icon: <Upload size={13} />, text: "Uploaded ZIP" };
}

export const RUNTIME: Record<string, string> = { auto: "Auto", static: "Static", node: "Node.js", python: "Python", php: "PHP", go: "Go", docker: "Dockerfile", image: "Image" };

