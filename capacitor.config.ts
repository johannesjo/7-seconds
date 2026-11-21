import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.johannesjo.sevenseconds",
  appName: "7 Seconds",
  webDir: "dist",
  server: {
    url: "https://johannesjo.github.io/7-seconds/",
    cleartext: false,
    // Bundled page shown when the game can't load (no connection). Its button
    // retries. shortcut: the app needs a connection to start — bundle dist and
    // drop server.url if offline play matters, at the cost of a store release
    // for every rules change the referee enforces.
    errorPath: "offline.html",
  },
};

export default config;
