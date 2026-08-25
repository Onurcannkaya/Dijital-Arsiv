import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Kurum içi UI imajı kendi küçük Node sunucusuyla taşınır. Normal
  // Cloudflare/Sites derlemesi aynı kalır; hedef yalnız Docker build sırasında
  // seçilir.
  output: process.env.ARCHIVE_BUILD_TARGET === "onprem-ui" ? "standalone" : undefined,
};

export default nextConfig;
