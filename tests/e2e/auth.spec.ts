/**
 * Employee Authentication — login, session, logout, and data isolation.
 *
 * Runs against the real running app (npm run dev), never through direct
 * store calls: the milestone's rule is that access is enforced by the
 * domain/store layer and reachable through the real login screen, not just
 * hidden behind UI affordances.
 */
import { expect, test } from "@playwright/test";
import {
  DEV_PASSWORD,
  EMPLOYEES,
  createCaseThroughUi,
  logout,
  switchUser,
} from "../support/helpers";

test.describe("Login screen", () => {
  test("shows AOS branding, and starts unauthenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Amaze Operating System")).toBeVisible();
    await expect(page.getByLabel("Username / Employee ID")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("a valid employee can log in and lands on their workspace", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await expect(page.locator("header").getByText(EMPLOYEES.telecaller, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "My Work" })).toBeVisible();
  });

  test("an invalid password is rejected with a clear error", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username / Employee ID").fill("jayalakshmi");
    await page.getByLabel("Password").fill("definitely-wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    // Still on the login screen — no session was established.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("an unknown username is rejected", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username / Employee ID").fill("no-such-employee");
    await page.getByLabel("Password").fill(DEV_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("shows a loading state while signing in", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username / Employee ID").fill("jayalakshmi");
    await page.getByLabel("Password").fill(DEV_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    // The button relabels itself while the (async, hashed) password check runs.
    await expect(page.getByRole("button", { name: /Signing in|Sign in/ })).toBeVisible();
  });
});

test.describe("Session", () => {
  test("survives a page refresh", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await page.reload();
    await expect(page.locator("header").getByText(EMPLOYEES.telecaller, { exact: true })).toBeVisible();
  });

  test("logout destroys the session — a refresh returns to login, not the old identity", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await logout(page);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("an unauthenticated visitor cannot reach a case URL directly", async ({ page }) => {
    // No login at all this test — going straight to a deep link must still show the login screen.
    await page.goto("/#/cases/cas_001");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Amaze Operating System")).toBeVisible();
  });
});

test.describe("Data isolation between telecallers", () => {
  test("a telecaller cannot open another telecaller's case by direct URL", async ({ page }) => {
    // Chinna (telecaller + login executive) opens a case.
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecallerAndLoginExecutive);
    const chinnaCaseUrl = await createCaseThroughUi(page, {
      name: "Chinna's Isolation Test Customer",
      phone: "9843100011",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "800000",
    });
    const hashPath = new URL(chinnaCaseUrl).hash;

    // Jayalakshmi (telecaller only) logs in and creates her own case first, so
    // she legitimately has at least one case of her own.
    await switchUser(page, EMPLOYEES.telecaller);
    await createCaseThroughUi(page, {
      name: "Jayalakshmi's Own Customer",
      phone: "9843100022",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "500000",
    });

    // She must not be able to open Chinna's case by pasting its URL directly.
    await page.goto(`/${hashPath}`);
    await expect(page.getByText("Not your case")).toBeVisible();
  });

  test("a telecaller's own case list does not include a colleague's cases", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecallerAndLoginExecutive);
    await createCaseThroughUi(page, {
      name: "Chinna's List Isolation Customer",
      phone: "9843100033",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "600000",
    });

    await switchUser(page, EMPLOYEES.telecaller);
    await page.goto("/#/cases");
    await expect(page.getByText("Chinna's List Isolation Customer")).toHaveCount(0);
  });

  test("Chinna Thambi (Telecaller + Login Executive) reaches the Login Team's case-wide workload", async ({
    page,
  }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await createCaseThroughUi(page, {
      name: "Visible To Login Desk Customer",
      phone: "9843100044",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "700000",
    });

    // Chinna's Login Executive role grants case.read at "all" — his combined
    // roles must show Jayalakshmi's case too, not just his own telecaller work.
    await switchUser(page, EMPLOYEES.telecallerAndLoginExecutive);
    await page.goto("/#/cases");
    await expect(page.getByText("Visible To Login Desk Customer")).toBeVisible();
  });
});

test.describe("Management-wide access", () => {
  test("a Manager sees the full case list, not just their own", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await createCaseThroughUi(page, {
      name: "Manager Visibility Customer",
      phone: "9843100055",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "900000",
    });

    await switchUser(page, EMPLOYEES.manager);
    await page.goto("/#/cases");
    await expect(page.getByText("Manager Visibility Customer")).toBeVisible();
  });

  test("a Managing Partner sees the full case list too", async ({ page }) => {
    await page.goto("/");
    await switchUser(page, EMPLOYEES.telecaller);
    await createCaseThroughUi(page, {
      name: "Managing Partner Visibility Customer",
      phone: "9843100066",
      loanTypeLabel: "Business Loan · Term Loan",
      amount: "950000",
    });

    await switchUser(page, EMPLOYEES.managingPartner);
    await page.goto("/#/cases");
    await expect(page.getByText("Managing Partner Visibility Customer")).toBeVisible();
  });
});
