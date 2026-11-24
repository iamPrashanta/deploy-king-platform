import "./globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";
import TRPCProvider from "@/trpc/Provider";
import { AuthProvider } from "@/components/AuthProvider";
import SessionManager from "@/components/SessionManager";
import Shell from "@/components/shell/Shell";
import { ThemeProvider, themeBootScript } from "@/components/theme";
import { Toaster } from "sonner";

const inter = Inter({ subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], display: "swap", variable: "--mono" });

export const metadata = {
  title: "Deploy King",
  description: "Deploy any website from Git, a Docker image or a template, with checks before every deploy.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={mono.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className={inter.className}>
        <ThemeProvider>
          <TRPCProvider>
            <AuthProvider>
              <SessionManager />
              <Shell>{children}</Shell>
              <Toaster position="bottom-right" theme="system" richColors closeButton />
            </AuthProvider>
          </TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
