import { http, createConfig } from "wagmi";
import { defineChain } from "viem";
import { injected } from "wagmi/connectors";
import { CHAIN_ID, RPC_URL } from "./contracts";

export const baseChain = defineChain({
  id: CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "BaseScan", url: "https://basescan.org" },
  },
});

export const wagmiConfig = createConfig({
  chains: [baseChain],
  connectors: [injected()],
  transports: { [baseChain.id]: http(RPC_URL) },
  ssr: true,
});
