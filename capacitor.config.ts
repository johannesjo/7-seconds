import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.johannesjo.sevenseconds",
  appName: "7 Seconds",
  webDir: "dist",
  server: {
    url: "https://johannesjo.github.io/7-seconds/",
    cleartext: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["sound", "alert"],
    },
  },
};

export default config;
