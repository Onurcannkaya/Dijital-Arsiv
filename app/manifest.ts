import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return { name: "Sivas Belediyesi Dijital Arşiv Yönetim Sistemi", short_name: "Sivas Arşiv", description: "Yapay zekâ destekli belge tasnif ve doğrulama çalışma alanı", start_url: "/archive", display: "standalone", background_color: "#f5f7f9", theme_color: "#17202b", lang: "tr", icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }] };
}