import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    // wagmi's connector index transitively imports Coinbase CDP x402 helpers we
    // never use (injected connector only); the package is absent, so stub it.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm": false,
      "@base-org/account": false,
      "@coinbase/cdp-sdk": false,
    };
    return config;
  },
};

export default nextConfig;
