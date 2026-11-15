import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "convex",
          include: ["tests/convex/**/*.test.ts"],
          environment: "edge-runtime",
          env: {
            BUNNY_STORAGE_ZONE: "test-zone",
            BUNNY_API_KEY: "test-api-key",
            BUNNY_CDN_HOSTNAME: "test.b-cdn.net",
          },
        },
      },
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
