"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  Database,
  FolderOpen,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  Server,
  Archive,
  Workflow,
  Users,
  ShieldAlert,
  Clock,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { isBarePath } from "@/components/paths";
import { ThemeSwitch } from "@/components/theme";
import { cx, useClickAway } from "@/components/ui";
import { CommandPalette } from "./CommandPalette";
import { trpc } from "@/utils/trpc";

export const Crown = ({ size = 15 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z" />
  </svg>
);

// ── Breadcrumbs: pages describe where they are; the header renders it ──────
export type Crumb = { label: string; href?: string };
const CrumbContext = createContext<(c: Crumb[]) => void>(() => {});
export function useCrumbs(crumbs: Crumb[]) {
  const set = useContext(CrumbContext);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}

type NavItem = { href: string; label: string; icon: React.ReactNode; soon?: boolean; match?: (p: string) => boolean; count?: "apps" | "dbs"; adminOnly?: boolean };
const NAV: Array<{ group?: string; items: NavItem[] }> = [
  {
    items: [
      { href: "/", label: "Overview", icon: <LayoutDashboard size={17} />, match: (p) => p === "/" },
      { href: "/apps", label: "Applications", icon: <Boxes size={17} />, match: (p) => p.startsWith("/apps") || p.startsWith("/sites"), count: "apps" },
      { href: "/templates", label: "Templates", icon: <LayoutTemplate size={17} /> },
      { href: "/workflows", label: "Workflows", icon: <Workflow size={17} /> },
      { href: "/scheduled-jobs", label: "Scheduled jobs", icon: <Clock size={17} /> },
    ],
  },
  {
    group: "Data",
    items: [
      { href: "/databases", label: "Databases", icon: <Database size={17} />, count: "dbs" },
      { href: "/backups", label: "Backups", icon: <Archive size={17} />, match: (p) => p.startsWith("/backups") || p.startsWith("/backup-cli") },
      { href: "/files", label: "Files", icon: <FolderOpen size={17} /> },
    ],
  },
  {
    group: "Platform",
    items: [
      { href: "/agents", label: "AI agents", icon: <Bot size={17} /> },
      { href: "/servers", label: "Servers", icon: <Server size={17} />, soon: true },
      { href: "/team", label: "Team", icon: <Users size={17} />, adminOnly: true },
      { href: "/security", label: "Security", icon: <ShieldAlert size={17} />, adminOnly: true },
      { href: "/settings", label: "Settings", icon: <Settings size={17} /> },
    ],
  },
];

/** Routes that render without the app shell. */
/** Routes that use the narrow icon rail to give the canvas room (workflow editor and runs). */
const RAIL = [/^\/workflows\/[^/]+/];

function Sidebar({ rail, open, onToggleRail, onNavigate }: { rail: boolean; open: boolean; onToggleRail: () => void; onNavigate: () => void }) {
  const pathname = usePathname();
  const active = (i: NavItem) => (i.match ? i.match(pathname) : pathname.startsWith(i.href));
  const sites = trpc.sites.list.useQuery(undefined, { staleTime: 30_000 });
  const dbs = trpc.database.count.useQuery(undefined, { staleTime: 60_000 });
  const counts: Record<string, number | undefined> = { apps: sites.data?.filter((s: any) => !s.isPreview).length, dbs: dbs.data };
  const isAdmin = useAuth().user?.role === "admin";
  return (
    <aside className={cx("sidebar", rail && "rail", open && "open")}>
      <Link href="/" className="sb-brand" onClick={onNavigate}>
        <span className="logo"><Crown /></span>
        {!rail && <span className="name">Deploy King</span>}
      </Link>
      <nav className="sb-nav">
        {NAV.map((g, gi) => (
          <React.Fragment key={gi}>
            {g.group && <div className="sb-group">{g.group}</div>}
            {g.items.filter((i) => !i.adminOnly || isAdmin).map((i) =>
              i.soon ? (
                <div key={i.href} className="sb-item disabled" title={`${i.label}: coming soon`}>
                  {i.icon}
                  <span>{i.label}</span>
                  <em className="soon">Soon</em>
                </div>
              ) : (
                <Link key={i.href} href={i.href} className={cx("sb-item", active(i) && "active")} title={rail ? i.label : undefined} onClick={onNavigate}>
                  {i.icon}
                  <span>{i.label}</span>
                  {i.count && counts[i.count] ? <em className="count">{counts[i.count]}</em> : null}
                </Link>
              )
            )}
          </React.Fragment>
        ))}
      </nav>
      {!rail && (
        <div className="sb-note">
          <strong>Deploys stay up</strong>
          <span>A new release only takes traffic after its health check passes.</span>
        </div>
      )}
      <div className="sb-foot">
        <button className="sb-item desktop-only" onClick={onToggleRail} title={rail ? "Expand sidebar" : "Collapse sidebar"}>
          {rail ? <ChevronsRight size={17} /> : <ChevronsLeft size={17} />}
          <span>Collapse</span>
        </button>
      </div>
    </aside>
  );
}

function GearMenu() {
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label="Appearance and settings" title="Appearance and settings" onClick={() => setOpen((o) => !o)}>
        <Settings size={17} />
      </button>
      {open && (
        <div className="menu" style={{ minWidth: 260 }}>
          <div className="mh">Theme</div>
          <div style={{ padding: "0 6px 8px" }}>
            <ThemeSwitch />
          </div>
          <div className="faint tiny" style={{ padding: "0 9px 8px" }}>Auto follows your device's light or dark setting.</div>
          <div className="sep" />
          <Link href="/settings" className="mi" onClick={() => setOpen(false)}>
            <Settings size={15} /> All settings
          </Link>
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));
  const name = user?.username ?? "";
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account">
        {name.charAt(0).toUpperCase() || "·"}
      </button>
      {open && (
        <div className="menu">
          <div className="mh">
            <div className="strong" style={{ color: "var(--text)", fontSize: 13 }}>{name}</div>
            <div>{user?.role === "admin" ? "Administrator" : "Member"}</div>
          </div>
          <div className="sep" />
          <button className="mi" onClick={logout}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Header({ crumbs, onMenu, onSearch }: { crumbs: Crumb[]; onMenu: () => void; onSearch: () => void }) {
  return (
    <header className="header">
      <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Menu">
        <Menu size={18} />
      </button>
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {c.href && i < crumbs.length - 1 ? <Link href={c.href}>{c.label}</Link> : <span className={i === crumbs.length - 1 ? "current" : ""}>{c.label}</span>}
          </React.Fragment>
        ))}
      </nav>
      <div className="spacer" />
      <button className="search-btn" onClick={onSearch}>
        <Search size={14} />
        <span className="label-text">Search apps and pages</span>
        <kbd>Ctrl K</kbd>
      </button>
      <Link href="/apps/new" className="btn btn-primary btn-sm desktop-only">
        <Plus size={14} /> New app
      </Link>
      <GearMenu />
      <AccountMenu />
    </header>
  );
}

function Footer() {
  const info = trpc.system.info.useQuery(undefined, { staleTime: 5 * 60_000 });
  return (
    <footer className="footer">
      <span>Deploy King {info.data?.version ? `v${info.data.version}` : ""}</span>
      {info.data && <span className="desktop-only">Apps on *.{info.data.baseDomain}</span>}
      <span className="spacer" />
      <Link href="/backup-cli">Backup CLI</Link>
      <a href="https://github.com/iamPrashanta/deploy-king-platform" target="_blank" rel="noreferrer">GitHub</a>
      <Link href="/settings">Server checks</Link>
    </footer>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [userRail, setUserRail] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    try {
      setUserRail(localStorage.getItem("dk-rail") === "1");
    } catch {}
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const forcedRail = RAIL.some((r) => r.test(pathname));
  const rail = forcedRail || userRail;
  const setCrumbsStable = useMemo(() => (c: Crumb[]) => setCrumbs(c), []);

  if (isBarePath(pathname)) return <>{children}</>;

  return (
    <CrumbContext.Provider value={setCrumbsStable}>
      <div className="shell">
        <Sidebar
          rail={rail}
          open={mobileOpen}
          onNavigate={() => setMobileOpen(false)}
          onToggleRail={() => {
            const next = !userRail;
            setUserRail(next);
            try {
              localStorage.setItem("dk-rail", next ? "1" : "0");
            } catch {}
          }}
        />
        {mobileOpen && <div className="scrim" onClick={() => setMobileOpen(false)} />}
        <div className="main">
          <Header crumbs={crumbs} onMenu={() => setMobileOpen(true)} onSearch={() => setPaletteOpen(true)} />
          <div className="scroll">
            {children}
            {!forcedRail && <Footer />}
          </div>
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onGo={(href) => router.push(href)} />
      </div>
    </CrumbContext.Provider>
  );
}
