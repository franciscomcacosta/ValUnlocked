/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Discord bot isn't part of the Next build; it runs as its own process.
  serverExternalPackages: ["discord.js"],
};
export default nextConfig;
