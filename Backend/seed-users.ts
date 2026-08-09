#!/usr/bin/env node
/**
 * Create the AOS employee accounts.
 *
 * WHY THIS EXISTS: authentication is now server-side, which creates a
 * bootstrap problem every such system has — you cannot log in to create the
 * first user. This is that first step, and it is also what puts the five roles
 * on the board that the Stage 2 acceptance test exercises.
 *
 * Idempotent: run it as often as you like. An existing username is left
 * completely alone, including its password — this never resets an account
 * somebody is already using.
 *
 * THE PASSWORD IS NOT A SECRET AND MUST NOT BECOME ONE. It comes from
 * AOS_SEED_PASSWORD, or falls back to a value that is written down in this
 * file and therefore public. These are development and acceptance-test
 * accounts. Before AOS carries real customer data, every one of these
 * passwords is changed and the unused accounts deactivated — see the Stage 2
 * report.
 */

import { randomUUID } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { pool, withActor } from "./db.js";

const PASSWORD = process.env.AOS_SEED_PASSWORD ?? "aos-dev-password";

const EMPLOYEES: readonly { username: string; fullName: string; role: Role }[] = [
  { username: "telecaller.a", fullName: "Telecaller A", role: "telecaller" },
  { username: "telecaller.b", fullName: "Telecaller B", role: "telecaller" },
  { username: "login.exec", fullName: "Login Executive", role: "login_executive" },
  { username: "manager.m", fullName: "Manager M", role: "manager" },
  { username: "partner.p", fullName: "Managing Partner P", role: "managing_partner" },
];

async function main(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);

  await withActor(null, async (client) => {
    for (const employee of EMPLOYEES) {
      const existing = await client.query(`select id from app_user where username = $1`, [
        employee.username,
      ]);
      if (existing.rows[0]) {
        console.log(`  exists   ${employee.username}`);
        continue;
      }

      // An employee is a person first — the same table customers live in
      // (ADR-013: one row per human, whatever their relationship to Amaze).
      const person = await client.query<{ id: string }>(
        `insert into person (full_name) values ($1) returning id`,
        [employee.fullName],
      );
      const personId = person.rows[0]!.id;

      const user = await client.query<{ id: string }>(
        `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
         values ($1, $2, $3, $4, true) returning id`,
        [personId, randomUUID(), employee.username, passwordHash],
      );
      const userId = user.rows[0]!.id;

      await client.query(
        `insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`,
        [userId, employee.role],
      );

      console.log(`  created  ${employee.username.padEnd(14)} ${employee.role}`);
    }
  });

  await pool.end();
  console.log(
    `\nDone. Password for newly created accounts came from ` +
      `${process.env.AOS_SEED_PASSWORD ? "AOS_SEED_PASSWORD" : "the documented default"}.`,
  );
}

await main();
