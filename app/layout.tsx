import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "./pwa-register";

export const metadata: Metadata = {
  title: { default: "Sivas Arşiv", template: "%s | Sivas Arşiv" },
  description: "Sivas Belediyesi Dijital Arşiv Yönetim Sistemi",
  applicationName: "Sivas Arşiv",
  icons: { icon: "/logo-sivas.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#17202b" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="tr"><body>{children}<PwaRegister /></body></html>;
}