import { defineConfig } from "vitest/config";

// The core's tests run in the plain node environment, exactly as they did in the
// web client: nothing here touches a DOM, which is the point of the package.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
