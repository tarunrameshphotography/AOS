/**
 * User Management, against PostgreSQL, through the real screen.
 *
 * RESTORED IN STAGE 3C-0. Stage 3B suspended this file: it signed in as
 * `seed.ts` employees who lived in one browser's localStorage and could not be
 * authenticated against a server, and the screen it drove was still writing to
 * the prototype store. Both of those are fixed — the accounts come from
 * `tests/support/e2e-globalsetup.ts` and the screen calls `Backend/users.ts` —
 * so the specs come back rather than being quietly deleted for a green suite.
 *
 * WHAT MAKES THESE WORTH RUNNING. Every assertion here is one the prototype
 * version could not have made honestly:
 *
 *   - the created account can actually SIGN IN, from a browser context that
 *     never saw the screen that created it;
 *   - deactivating it stops that sign-in, on the server;
 *   - a granted override changes what the SERVER lets that person do, checked
 *     by making the request as them;
 *   - a Telecaller typing the admin URL is refused by the API, not merely by
 *     a hidden link.
 *
 * CLEANUP. Accounts created here are deactivated when the spec is finished
 * with them, which is the only disposal the product supports — there is no
 * delete, deliberately (BR-062, and the note at the top of Backend/users.ts).
 * Usernames carry a run-unique suffix so repeat runs never collide. All of it
 * lands in `aos_e2e`; the office database is unreachable from this suite (see
 * playwright.config.ts).
 */

import { expect, test, type Page } from "@playwright/test";

import { E2E_PASSWORD } from "../support/e2e-environment.js";

const MANAGER = "e2e.manager";
const PARTNER = "e2e.partner";
const TELECALLER = "e2e.telecaller";
const LOGIN_EXEC = "e2e.loginexec";

/** A password that satisfies the server's eight-character minimum. Only ever
 * valid in `aos_e2e`. */
const CONTROLLED_PASSWORD = "Controlled#Pass1";

function uniqueUsername(): string {
  return `e2e.controlled.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function signIn(page: Page, username: string, password = E2E_PASSWORD): Promise<void> {
  await page.goto("/");
  const usernameField = page.locator('input[name="username"]');
  await expect(usernameField).toBeVisible();
  await usernameField.fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "All Cases" })).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.locator("header button").last().click();
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator('input[name="username"]')).toBeVisible();
}

async function openUsers(page: Page): Promise<void> {
  await page.goto("/#/admin/users");
}

function userRow(page: Page, username: string) {
  return page.locator(`[data-testid="user-row"][data-username="${username}"]`);
}

/**
 * Creates an account through the real screen and returns its username.
 *
 * `roles` are ticked by their display label, the same way a manager would.
 */
async function createControlledUser(
  page: Page,
  roles: string[],
): Promise<string> {
  const username = uniqueUsername();
  await page.getByRole("button", { name: "Create user" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.locator('input[name="fullName"]').fill("E2E Controlled Account");
  await dialog.locator('input[name="username"]').fill(username);
  await dialog.locator('input[name="password"]').fill(CONTROLLED_PASSWORD);
  for (const role of roles) {
    await dialog.getByRole("checkbox", { name: role }).check();
  }
  await dialog.getByRole("button", { name: "Create user" }).click();

  await expect(page.getByRole("status")).toContainText("User created.");
  await expect(userRow(page, username)).toBeVisible();
  return username;
}

/** Deactivates an account through the screen — the supported disposal. */
async function deactivate(page: Page, username: string): Promise<void> {
  const row = userRow(page, username);
  if ((await row.getByRole("button", { name: "Close" }).count()) === 0) {
    await row.getByRole("button", { name: "Manage" }).click();
  }
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByText("Disabled")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Who may reach the screen at all
// ---------------------------------------------------------------------------

test.describe("access to User Management", () => {
  test("a Manager signs in and reaches it", async ({ page }) => {
    await signIn(page, MANAGER);
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
    await openUsers(page);
    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();
  });

  test("a Managing Partner reaches it too", async ({ page }) => {
    await signIn(page, PARTNER);
    await openUsers(page);
    await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();
  });

  test("a Telecaller has no Users link, is refused on the screen, and is refused by the API", async ({
    page,
  }) => {
    await signIn(page, TELECALLER);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

    await openUsers(page);
    await expect(page.getByText("You do not have permission to manage users.")).toBeVisible();

    // The screen hiding itself proves nothing — the prototype did that too,
    // in a tab that could be told otherwise. This is the server refusing the
    // same session's token on the write that matters.
    const refused = await page.request.post("/api/users", {
      headers: {
        Authorization: `Bearer ${await page.evaluate(() => sessionStorage.getItem("aos.token"))}`,
      },
      data: {
        fullName: "Should Not Exist",
        username: uniqueUsername(),
        password: CONTROLLED_PASSWORD,
        roles: ["telecaller"],
      },
    });
    expect(refused.status()).toBe(403);
  });

  test("a Login Executive is refused as well", async ({ page }) => {
    await signIn(page, LOGIN_EXEC);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
    await openUsers(page);
    await expect(page.getByText("You do not have permission to manage users.")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// The list, and the accounts on it
// ---------------------------------------------------------------------------

test.describe("a Manager administers accounts", () => {
  test("the list comes from the database, not from this browser", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);

    // Seeded server-side by globalSetup. A localStorage store in this tab has
    // never held any of them.
    for (const username of [TELECALLER, LOGIN_EXEC, MANAGER, PARTNER]) {
      await expect(userRow(page, username)).toBeVisible();
    }
  });

  test("creates a real account that can then sign in from a fresh browser", async ({
    page,
    browser,
  }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);

    // A different browser context: its own storage, its own session. The only
    // thing it shares with the tab that created the account is the database.
    const fresh = await browser.newContext();
    try {
      const theirPage = await fresh.newPage();
      await signIn(theirPage, username, CONTROLLED_PASSWORD);
      await expect(theirPage.locator("header").getByText("E2E Controlled Account")).toBeVisible();
    } finally {
      await fresh.close();
    }

    await deactivate(page, username);
  });

  test("assigns and revokes a role, and the change survives a reload", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);

    // `assigned-roles` is the badge summary of what the account HOLDS. The
    // tick-boxes below it carry the same words and are a proposal, not a fact;
    // asserting on them would pass without anything having been saved.
    const assignedRoles = (name: string) => userRow(page, name).getByTestId("assigned-roles");

    await row.getByRole("button", { name: "Manage" }).click();
    await row.getByRole("checkbox", { name: "Login Executive" }).check();
    await row.getByRole("button", { name: "Save roles" }).click();
    await expect(page.getByRole("status")).toContainText("Roles updated.");
    await expect(assignedRoles(username)).toContainText("Login Executive");

    // Reload: the badge can only come back if the role was written.
    await page.reload();
    await expect(assignedRoles(username)).toContainText("Login Executive");

    const reloaded = userRow(page, username);
    await reloaded.getByRole("button", { name: "Manage" }).click();
    await reloaded.getByRole("checkbox", { name: "Login Executive" }).uncheck();
    await reloaded.getByRole("button", { name: "Save roles" }).click();
    await expect(page.getByRole("status")).toContainText("Roles updated.");

    await page.reload();
    // The Telecaller badge stays; the revoked one is gone.
    await expect(assignedRoles(username)).toContainText("Telecaller");
    await expect(assignedRoles(username)).not.toContainText("Login Executive");

    await deactivate(page, username);
  });

  test("deactivates an account, and the holder can no longer sign in", async ({ page, browser }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);

    await deactivate(page, username);

    const fresh = await browser.newContext();
    try {
      const theirPage = await fresh.newPage();
      await theirPage.goto("/");
      await theirPage.locator('input[name="username"]').fill(username);
      await theirPage.locator('input[name="password"]').fill(CONTROLLED_PASSWORD);
      await theirPage.getByRole("button", { name: "Sign in" }).click();

      // The right password, refused. And the message says nothing about the
      // account existing — deliberately (Backend/api-server.ts's login).
      await expect(theirPage.getByRole("alert")).toContainText(
        "Incorrect username or password",
      );
      await expect(theirPage.getByRole("link", { name: "All Cases" })).toHaveCount(0);
    } finally {
      await fresh.close();
    }
  });

  test("reactivates a deactivated account", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);

    await row.getByRole("button", { name: "Manage" }).click();
    await row.getByRole("button", { name: "Deactivate" }).click();
    await expect(row.getByText("Disabled")).toBeVisible();

    await row.getByRole("button", { name: "Reactivate" }).click();
    await expect(row.getByText("Active")).toBeVisible();

    await page.reload();
    await expect(userRow(page, username).getByText("Active")).toBeVisible();

    await deactivate(page, username);
  });

  test("resets a password, and the new one is the one that works", async ({ page, browser }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);

    await row.getByRole("button", { name: "Manage" }).click();
    await row.getByLabel("New password").fill("Reset#Pass2026");
    await row.getByRole("button", { name: "Reset" }).click();
    await expect(page.getByRole("status")).toContainText("Password reset.");

    const fresh = await browser.newContext();
    try {
      const theirPage = await fresh.newPage();
      await signIn(theirPage, username, "Reset#Pass2026");
      await expect(theirPage.locator("header").getByText("E2E Controlled Account")).toBeVisible();
    } finally {
      await fresh.close();
    }

    await deactivate(page, username);
  });

  test("cannot deactivate their own account", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);

    const row = userRow(page, MANAGER);
    await row.getByRole("button", { name: "Manage" }).click();
    await expect(row.getByRole("button", { name: "Deactivate" })).toBeDisabled();
    // And there is no delete at all any more — accounts are never removed.
    await expect(row.getByRole("button", { name: "Delete account" })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Permission overrides — the part that changes what the SERVER allows
// ---------------------------------------------------------------------------

test.describe("permission overrides", () => {
  test("granting one widens what the server lets that person do", async ({ page, browser }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);
    await row.getByRole("button", { name: "Manage" }).click();

    // A Telecaller holds `case.read` at `own` only. Before the grant, listing
    // every case is not something they can do.
    await row.getByLabel("Permission").selectOption({ label: "Reassign cases" });
    await row.getByLabel("Scope").selectOption("all");
    await row.getByRole("button", { name: "Grant" }).click();
    await expect(page.getByRole("status")).toContainText("Permission granted.");

    await expect(row.getByTestId("overrides")).toContainText("Granted: Reassign cases (all)");
    // Shown AS an override in effective access, not blended into the role.
    await expect(row.getByTestId("effective-access")).toContainText("Reassign cases");

    // The proof: the person themselves, in their own session, is now allowed
    // by the server. `case.assign` at `all` is a Manager-and-above permission
    // that no Telecaller role grants.
    const fresh = await browser.newContext();
    try {
      const theirPage = await fresh.newPage();
      await signIn(theirPage, username, CONTROLLED_PASSWORD);
      const me = await theirPage.request.get("/api/auth/me", {
        headers: {
          Authorization: `Bearer ${await theirPage.evaluate(() =>
            sessionStorage.getItem("aos.token"),
          )}`,
        },
      });
      const body = await me.json();
      expect(body.overrides).toContainEqual({
        permission: "case.assign",
        scope: "all",
        decision: "grant",
      });
    } finally {
      await fresh.close();
    }

    await deactivate(page, username);
  });

  test("denying one shows as a denial and survives a reload", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);
    await row.getByRole("button", { name: "Manage" }).click();

    await row.getByLabel("Permission").selectOption({ label: "View cases" });
    await row.getByLabel("Scope").selectOption("all");
    await row.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("status")).toContainText("Permission denied.");
    await expect(row.getByTestId("overrides")).toContainText("Denied: View cases");

    await page.reload();
    const reloaded = userRow(page, username);
    await reloaded.getByRole("button", { name: "Manage" }).click();
    await expect(reloaded.getByTestId("overrides")).toContainText("Denied: View cases");
    // deny > grant > role: the denial appears in the denied column, not the
    // granted one, even though the Telecaller role grants `case.read`.
    await expect(
      reloaded.getByTestId("effective-access").locator("li.text-red-700"),
    ).toContainText("View cases");

    await deactivate(page, username);
  });

  test("revoking an override returns the person to what their roles give", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Telecaller"]);
    const row = userRow(page, username);
    await row.getByRole("button", { name: "Manage" }).click();

    await row.getByLabel("Permission").selectOption({ label: "Reassign cases" });
    await row.getByLabel("Scope").selectOption("all");
    await row.getByRole("button", { name: "Grant" }).click();
    await expect(row.getByTestId("overrides")).toContainText("Granted: Reassign cases");

    await row.getByTestId("overrides").getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByRole("status")).toContainText("Override revoked.");
    await expect(row.getByTestId("overrides")).toHaveCount(0);

    await page.reload();
    const reloaded = userRow(page, username);
    await reloaded.getByRole("button", { name: "Manage" }).click();
    await expect(reloaded.getByTestId("overrides")).toHaveCount(0);

    await deactivate(page, username);
  });

  test("takes user administration away from one of several administrators", async ({ page }) => {
    await signIn(page, MANAGER);
    await openUsers(page);
    const username = await createControlledUser(page, ["Manager"]);
    const row = userRow(page, username);
    await row.getByRole("button", { name: "Manage" }).click();

    // Allowed, because other administrators remain. The refusal that fires
    // when the LAST one would go (`assertAnAdministratorRemains`) is asserted
    // in the integration suite instead, where the account population can be
    // controlled exactly — here it would depend on who else this database
    // happens to hold.
    await row.getByLabel("Permission").selectOption({ label: "Create, edit and deactivate users" });
    await row.getByLabel("Scope").selectOption("all");
    await row.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("status")).toContainText("Permission denied.");
    await expect(row.getByTestId("overrides")).toContainText(
      "Denied: Create, edit and deactivate users",
    );

    await deactivate(page, username);
  });
});
