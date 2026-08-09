import { describe, expect, test } from "vitest";

import { classifyStorageState } from "./storage-state.js";

describe("classifyStorageState", () => {
  test("ok when the object exists under the current root", () => {
    expect(
      classifyStorageState({
        documentStorageRoot: "C:\\AOS\\Data",
        currentStorageRoot: "C:\\AOS\\Data",
        exists: true,
      }),
    ).toBe("ok");
  });

  test("missing when the object does not exist under a matching root", () => {
    expect(
      classifyStorageState({
        documentStorageRoot: "C:\\AOS\\Data",
        currentStorageRoot: "C:\\AOS\\Data",
        exists: false,
      }),
    ).toBe("missing");
  });

  test("root-changed when the configured root no longer matches the one recorded at upload", () => {
    expect(
      classifyStorageState({
        documentStorageRoot: "C:\\AOS\\Data",
        currentStorageRoot: "D:\\Moved\\Data",
        exists: false,
      }),
    ).toBe("root-changed");
  });

  test("root-changed takes priority even if the backend happens to report the path exists", () => {
    // e.g. two different roots that coincidentally both have something at that
    // relative path — the mismatch itself is the actionable fact.
    expect(
      classifyStorageState({
        documentStorageRoot: "C:\\AOS\\Data",
        currentStorageRoot: "D:\\Moved\\Data",
        exists: true,
      }),
    ).toBe("root-changed");
  });

  test("documents uploaded before root-tracking existed fall back to ok/missing", () => {
    expect(
      classifyStorageState({
        currentStorageRoot: "C:\\AOS\\Data",
        exists: true,
      }),
    ).toBe("ok");
    expect(
      classifyStorageState({
        currentStorageRoot: "C:\\AOS\\Data",
        exists: false,
      }),
    ).toBe("missing");
  });
});
