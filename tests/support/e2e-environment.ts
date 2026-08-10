/**
 * The browser suite's own environment: which database, which ports, which
 * accounts.
 *
 * A module of its own rather than constants in `e2e-globalsetup.ts`, because
 * `playwright.config.ts` needs them too and importing globalSetup from the
 * config would drag `pg` and a database connection into config evaluation.
 *
 * Everything here is a CONSTANT and deliberately not read from the
 * environment. `Backend/test-globalsetup.ts` learned this the hard way and
 * says so: a test bootstrap that reads `AOS_DB_NAME` picks up `.env` and
 * points the whole suite at the office database. It did exactly that once.
 */

import type { Role } from "../../src/domain/permissions/index.js";

/** The suite's database. Created and migrated by globalSetup; owned by nobody
 * else. Not `aos` (the office), not `aos_test` (the vitest integration suite,
 * which truncates and reseeds). */
export const E2E_DB = "aos_e2e";

/** Ports for the stack Playwright starts. Deliberately NOT 5173/4321 — those
 * belong to whatever the office has running, and the whole point is that the
 * two stacks cannot reach each other. */
export const E2E_VITE_PORT = 5174;
export const E2E_API_PORT = 4322;

/** A test credential and nothing else. It exists only in `aos_e2e`, which is
 * created by the suite and holds no real data. The office accounts are made by
 * `Backend/bootstrap-production.ts` and share nothing with this. */
export const E2E_PASSWORD = "e2e-test-password";

/**
 * The accounts the specs sign in as.
 *
 * One Telecaller is not enough: proving that a colleague's case is invisible
 * needs a second one. `e2e.partner` is not a spare Manager either — the User
 * Management specs need an administrator who can be locked out of nothing,
 * so that deactivating `e2e.manager` still leaves an administrator standing
 * and `assertAnAdministratorRemains` does not refuse the test's own setup.
 */
export const E2E_USERS: readonly { username: string; fullName: string; roles: Role[] }[] = [
  { username: "e2e.telecaller", fullName: "E2E Telecaller", roles: ["telecaller"] },
  { username: "e2e.telecaller2", fullName: "E2E Second Telecaller", roles: ["telecaller"] },
  { username: "e2e.loginexec", fullName: "E2E Login Executive", roles: ["login_executive"] },
  { username: "e2e.manager", fullName: "E2E Manager", roles: ["manager"] },
  { username: "e2e.partner", fullName: "E2E Managing Partner", roles: ["managing_partner"] },
];

/**
 * The names that mean "the office database", refused outright.
 *
 * `aos` is the live one. The check is a belt-and-braces companion to
 * `AOS_REQUIRE_DB_NAME` in `Backend/db.ts`: that one stops a SERVER connecting
 * to the wrong place, this one stops the SETUP — which creates databases, runs
 * migrations and inserts accounts — from doing so, and it runs before the
 * server exists.
 */
const OFFICE_DATABASES = ["aos", "aos_production", "aos_prod"];

export function assertNotOfficeDatabase(database: string): void {
  if (OFFICE_DATABASES.includes(database.trim().toLowerCase())) {
    throw new Error(
      `The end-to-end suite is configured against "${database}", which is an office database. ` +
        `It creates and deactivates accounts and would damage real data. Refusing to run.`,
    );
  }
}
