"use client";

import "@xterm/xterm/css/xterm.css";
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Circle, KeyRound, Lock, Plus, Power } from "lucide-react";
import { Spinner, cx } from "@/components/ui";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";

export type SshTerminalHandle = { run: (command: string) => boolean; end: () => void; isOpen: () => boolean };

type State = "idle" | "asking" | "connecting" | "open" | "closed" | "error";

const THEME = {
  background: "#060912", foreground: "#F1F4FB", cursor: "#FF7A1A", selectionBackground: "#2F6BFF55",
  black: "#0A0D16", red: "#F85149", green: "#3FB950", yellow: "#F5B83D", blue: "#4D82FF", magenta: "#86AAFF", cyan: "#6CC4FF", white: "#D8DEEE",
  brightBlack: "#7F8AA8", brightRed: "#FF7B72", brightGreen: "#56D364", brightYellow: "#FFD580", brightBlue: "#86AAFF", brightMagenta: "#B4C8FF", brightCyan: "#9BDCFF", brightWhite: "#FFFFFF",
};

/**
 * A terminal on a connected server: xterm.js in the browser, an SSH shell on the API's WebSocket gateway.
 * The access rules decide whether the panel password is asked first; a key with a passphrase asks for it too.
 */
export const SshTerminal = forwardRef<SshTerminalHandle, {
  serverId: string;
  title: string;
  askPassword: boolean;
  askPassphrase: boolean;
  idleMinutes: number;
  onChange?: (state: State, sessionId: string | null) => void;
}>(function SshTerminal({ serverId, title, askPassword, askPassphrase, idleMinutes, onChange }, ref) {
  const mount = useRef<HTMLDivElement>(null);
  const term = useRef<any>(null);
  const fit = useRef<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const sid = useRef<string | null>(null);
  const [state, setState] = useState<State>("idle");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const needsForm = askPassword || askPassphrase;

  const set = useCallback((s: State) => { setState(s); onChange?.(s, sid.current); }, [onChange]);

  // xterm, once
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      if (disposed || !mount.current) return;
      const t = new Terminal({ cursorBlink: true, theme: THEME, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 13, lineHeight: 1.35, scrollback: 5000 });
      const f = new FitAddon();
      t.loadAddon(f);
      t.open(mount.current);
      f.fit();
      term.current = t;
      fit.current = f;
      t.onData((data: string) => { if (sid.current && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "ssh.input", id: sid.current, data })); });
      t.onResize(({ cols, rows }: { cols: number; rows: number }) => { if (sid.current && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "ssh.resize", id: sid.current, cols, rows })); });
      ro = new ResizeObserver(() => { try { f.fit(); } catch {} });
      ro.observe(mount.current);
    })();
    return () => { disposed = true; ro?.disconnect(); term.current?.dispose(); term.current = null; };
  }, []);

  const connect = useCallback((pw?: string, pp?: string) => {
    setError("");
    set("connecting");
    ws.current?.close();
    const token = localStorage.getItem("token") ?? "";
    const sock = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`);
    ws.current = sock;
    sock.onopen = () => {
      const cols = term.current?.cols ?? 100, rows = term.current?.rows ?? 30;
      sock.send(JSON.stringify({ type: "ssh.open", serverId, cols, rows, password: pw || undefined, passphrase: pp || undefined }));
    };
    sock.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "ssh.opened" && m.serverId === serverId) {
        sid.current = m.sessionId;
        setRecording(!!m.recording);
        setPassword(""); setPassphrase("");
        term.current?.reset();
        term.current?.focus();
        set("open");
      } else if (m.channel === "ssh" && m.id === sid.current) {
        term.current?.write(m.payload.data);
      } else if (m.type === "ssh.closed" && m.sessionId === sid.current) {
        term.current?.write(`\r\n\x1b[90m[Session ended${m.reason && m.reason !== "ended" ? `: ${m.reason}` : ""}]\x1b[0m\r\n`);
        sid.current = null;
        set("closed");
        sock.close();
      } else if (m.type === "ssh.error") {
        setError(m.message || "The terminal could not be opened.");
        set(m.code === "PASSWORD_REQUIRED" || m.code === "PASSWORD_WRONG" || m.code === "PASSPHRASE" ? "asking" : "error");
        sock.close();
      }
    };
    sock.onclose = (ev) => {
      if (ev.code === 4001) { setError("Your session ended. Sign in again."); set("error"); }
      else if (sid.current) { sid.current = null; set("closed"); }
    };
  }, [serverId, set]);

  // open straight away when nothing has to be typed first
  useEffect(() => {
    if (needsForm) set("asking");
    else connect();
    return () => {
      if (sid.current && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "ssh.close", id: sid.current }));
      ws.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const end = () => {
    if (sid.current && ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "ssh.close", id: sid.current }));
  };

  useImperativeHandle(ref, () => ({
    run: (command: string) => {
      if (!sid.current || ws.current?.readyState !== WebSocket.OPEN) return false;
      ws.current.send(JSON.stringify({ type: "ssh.input", id: sid.current, data: command + "\r" }));
      term.current?.focus();
      return true;
    },
    end,
    isOpen: () => !!sid.current,
  }));

  return (
    <div className="card" style={{ overflow: "hidden", background: "var(--code-bg)" }}>
      <div className="card-head" style={{ background: "var(--card)", gap: 10 }}>
        <span className={cx("dot", state === "open" ? "ok" : state === "connecting" ? "warn pulse" : state === "error" ? "bad" : "")} />
        <span className="mono small strong">{title}</span>
        {state === "open" && recording && <span className="badge bad"><Circle size={8} fill="currentColor" /> Recording</span>}
        {state === "open" && idleMinutes > 0 && <span className="small faint desktop-only">Closes after {idleMinutes} min idle</span>}
        <span className="right row" style={{ gap: 6 }}>
          <a className="btn btn-sm btn-ghost" href={`/servers/${serverId}`} target="_blank" rel="noreferrer"><Plus size={13} /> New tab</a>
          {state === "open"
            ? <button className="btn btn-sm" onClick={end}><Power size={13} /> End session</button>
            : (state === "closed" || state === "error") && <button className="btn btn-sm" onClick={() => (needsForm ? set("asking") : connect())}>Open again</button>}
        </span>
      </div>
      <div style={{ position: "relative" }}>
        <div ref={mount} style={{ height: 420, padding: "8px 10px" }} aria-label="Terminal" />
        {state !== "open" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: state === "closed" ? "transparent" : "color-mix(in srgb, var(--code-bg) 88%, transparent)", pointerEvents: state === "closed" ? "none" : "auto" }}>
            {state === "connecting" && <div className="row muted small"><Spinner /> Connecting…</div>}
            {state === "error" && <div className="notice bad small" style={{ maxWidth: 460 }}>{error}</div>}
            {state === "asking" && (
              <form className="card card-pad stack" style={{ width: 360, gap: 10 }} onSubmit={(e) => { e.preventDefault(); connect(password, passphrase); }}>
                <div className="strong row" style={{ gap: 8 }}><Lock size={15} /> Open the terminal</div>
                {askPassword && (
                  <div>
                    <label className="label" htmlFor="ssh-pw">Your Deploy King password</label>
                    <input id="ssh-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
                    <div className="hint">This server asks for it before a terminal opens.</div>
                  </div>
                )}
                {askPassphrase && (
                  <div>
                    <label className="label" htmlFor="ssh-pp"><KeyRound size={12} style={{ verticalAlign: -1 }} /> The key's passphrase</label>
                    <input id="ssh-pp" className="input" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus={!askPassword} />
                  </div>
                )}
                {error && <div className="small bad-text">{error}</div>}
                <button className="btn btn-primary" type="submit" disabled={(askPassword && !password) || (askPassphrase && !passphrase)}>Open terminal</button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** Plays a recorded session (asciicast v2) in a read-only xterm, at its own pace or faster. */
export function ReplayPlayer({ cast }: { cast: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState(2);
  const [run, setRun] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let t: any = null;
    let stop = false;
    const timers: any[] = [];
    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (stop || !mount.current) return;
      const lines = cast.trim().split("\n");
      let header: any = {};
      try { header = JSON.parse(lines[0]); } catch {}
      t = new Terminal({ theme: THEME, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12.5, cols: header.width ?? 100, rows: Math.min(header.height ?? 30, 32), disableStdin: true, cursorBlink: false });
      t.open(mount.current);
      setDone(false);
      const events = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<[number, string, string]>;
      let last = 0;
      for (const [time, kind, data] of events) {
        // long pauses are shortened to one second, like asciinema's idle limit
        const at = last + Math.min(1, Math.max(0, time - last)) / speed;
        last = time;
        timers.push(setTimeout(() => {
          if (kind === "o") t.write(data);
          else if (kind === "r") { const [c, r] = data.split("x").map(Number); if (c && r) t.resize(c, Math.min(r, 32)); }
        }, at * 1000));
      }
      timers.push(setTimeout(() => setDone(true), (events.reduce((acc, [time], i) => acc + Math.min(1, Math.max(0, time - (i ? events[i - 1][0] : 0))), 0) / speed) * 1000 + 50));
    })();
    return () => { stop = true; timers.forEach(clearTimeout); t?.dispose(); };
  }, [cast, speed, run]);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div ref={mount} style={{ background: "var(--code-bg)", borderRadius: 8, padding: 8, overflow: "auto" }} />
      <div className="row" style={{ gap: 8 }}>
        <div className="seg" role="radiogroup" aria-label="Speed">
          {[1, 2, 4].map((s) => <button key={s} className={cx(speed === s && "on")} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
        <button className="btn btn-sm" onClick={() => setRun((r) => r + 1)}>Play again</button>
        {done && <span className="small faint">End of the recording</span>}
      </div>
    </div>
  );
}
