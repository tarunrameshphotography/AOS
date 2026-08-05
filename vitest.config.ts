import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    globals: true,
    // The domain layer is the covered core (src/). Frontend/src/fake is the
    // prototype's in-memory backend, not domain logic — but its requirement
    // generation is exactly the kind of code that silently lying (wrong
    // progress bar, wrong requirement count) does real damage, so it gets
    // tests too, run by the same command.
    include: ["src/**/*.test.ts", "Frontend/src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@domain": fileURLToPath(new URL("./src/domain", import.meta.url)),
    },
  },
});
