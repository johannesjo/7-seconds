import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.johannesjo.sevenseconds",
  appName: "7 Seconds",
  webDir: "dist",
  server: {
    url: "https://johannesgo.github.io/7-seconds/",
    cleartext: false,
  },
};

export default config;
