/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN || "http://localhost:5173"; // Express API

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_ORIGIN}/:path*`
      }
    ];
  }
};

module.exports = nextConfig;
