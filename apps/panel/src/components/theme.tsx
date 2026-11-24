"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type ThemeChoice = "dark" | "light" | "system";
const KEY = "dk-theme";

/** Runs before React hydrates (see layout.tsx) so the page never flashes the wrong theme. */
export const themeBootScript = `(function(){try{var c=localStorage.getItem("${KEY}")||"dark";var t=c==="system"?(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):c;document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

type Ctx = { choice: ThemeChoice; resolved: "dark" | "light"; setChoice: (c: ThemeChoice) => void };
const ThemeContext = createContext<Ctx>({ choice: "dark", resolved: "dark", setChoice: () => {} });

function resolve(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>("dark");
  const [resolved, setResolved] = useState<"dark" | "light">("dark");

  useEffect(() => {
    let saved: ThemeChoice = "dark";
    try {
      const v = localStorage.getItem(KEY);
      if (v === "light" || v === "dark" || v === "system") saved = v;
    } catch {}
    setChoiceState(saved);
  }, []);

  useEffect(() => {
    const apply = () => {
      const r = resolve(choice);
      setResolved(r);
      document.documentElement.setAttribute("data-theme", r);
    };
    apply();
    if (choice !== "system") return;
    // "Auto" follows the device: react when the OS switches between light and dark.
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {}
  }, []);

  return <ThemeContext.Provider value={{ choice, resolved, setChoice }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Dark / Light / Auto segmented switch, used in Settings and the account menu. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { choice, setChoice } = useTheme();
  const items: Array<{ v: ThemeChoice; label: string; icon: React.ReactNode }> = [
    { v: "dark", label: "Dark", icon: <Moon size={14} /> },
    { v: "light", label: "Light", icon: <Sun size={14} /> },
    { v: "system", label: "Auto", icon: <Monitor size={14} /> },
  ];
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {items.map((i) => (
        <button key={i.v} role="radio" aria-checked={choice === i.v} className={choice === i.v ? "on" : ""} onClick={() => setChoice(i.v)} title={i.v === "system" ? "Follow the device setting" : undefined}>
          {i.icon}
          {!compact && i.label}
        </button>
      ))}
    </div>
  );
}
