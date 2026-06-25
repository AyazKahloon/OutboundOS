/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing the workspace db package.
  transpilePackages: ["@outboundos/db"],
};

export default nextConfig;
