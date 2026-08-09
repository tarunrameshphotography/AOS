/**
 * Human-readable labels for the permission catalog.
 *
 * Source of truth: Employee Authentication milestone.
 *
 * `actions.ts` describes each permission for the engineer reading the catalog
 * — full sentences, ADR references, reasoning. Ordinary staff administering
 * users need a phrase, not a paragraph: "View all cases", not "See a case and
 * everything that hangs off it." This file is that short label, one per
 * permission key, checked by a test to cover every key in `PERMISSIONS` so a
 * newly added permission cannot go undescribed here.
 *
 * The raw key (`case.read`) is never shown to ordinary staff — the User
 * Management screen tucks it behind the existing `PermissionCode` "Technical
 * detail" disclosure (`Frontend/src/ui/index.tsx`), the same convention
 * already used elsewhere for exactly this purpose.
 */

export const PERMISSION_DISPLAY_NAME: Record<string, string> = {
  // Cases
  "case.read": "View cases",
  "case.create": "Create cases",
  "case.update": "Edit case details",
  "case.assign": "Reassign cases",
  "case.hold": "Place or lift a case hold",
  "case.mark_lost": "Mark a case lost",
  "case.reopen": "Reopen a lost case",
  "case.close": "Close a disbursed case",

  // People and organisations
  "person.read": "View people",
  "person.create": "Add people",
  "person.update": "Edit people",
  "person.merge": "Merge duplicate people",
  "person.override_duplicate": "Create a person flagged as a possible duplicate",
  "organisation.read": "View organisations",
  "organisation.create": "Add organisations",
  "organisation.update": "Edit organisations",
  "organisation.merge": "Merge duplicate organisations",
  "property.read": "View properties",
  "property.create": "Add properties",
  "property.update": "Edit properties",
  "property.merge": "Merge duplicate properties",
  "employment.read": "View employment details",
  "employment.record": "Add or edit employment details",

  // Documents
  "document.read": "View documents",
  "document.upload": "Upload documents",
  "document.verify": "Verify documents",
  "document.delete_version": "Delete a document version",
  "requirement.waive": "Waive a required document",

  // Banking
  "submission.read": "View bank submissions",
  "submission.create": "Submit to banks",
  "submission.update_status": "Update submission status",
  "offer.read": "View bank offers",
  "offer.record": "Record a bank offer",
  "offer.accept": "Accept a bank offer",

  // Work and communication
  "task.read": "View tasks",
  "task.create": "Create tasks",
  "task.update": "Update tasks",
  "task.assign": "Assign tasks to others",
  "communication.read": "View logged communications",
  "communication.log": "Log a communication",
  "note.read": "Read case notes",
  "note.create": "Write case notes",

  // Sensitive
  "identifier.view_full": "View full identifiers (e.g. full PAN)",
  "commercial.view": "View commercial figures (commission, fees)",
  "event.view": "View audit history",

  // Administration
  "user.read": "View user accounts",
  "user.manage": "Create, edit and deactivate users",
  "role.assign": "Assign or remove roles",
  "master_data.read": "View reference data",
  "master_data.manage": "Manage reference data (banks, document types, etc.)",
  "report.view": "View reports",
  "permission.override": "Grant or deny individual permissions",
};

/** `PERMISSION_DISPLAY_NAME[key]`, qualified by scope where that adds information. */
export function permissionDisplayName(key: string, scope?: "own" | "team" | "all"): string {
  const base = PERMISSION_DISPLAY_NAME[key] ?? key;
  if (scope === "own") {
    return `${base} (own only)`;
  }
  return base;
}
