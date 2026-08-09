/**
 * "Storage Location" + "Open Folder", shown on every document detail
 * surface (the verify/confirm dialog, a person's documents list). Reads the
 * configured storage root and checks the file is actually still on disk —
 * both live facts from the local storage backend, not values baked into the
 * document row, so they stay correct if the root is reconfigured later.
 */

import { useEffect, useState, type ReactNode } from "react";

import { classifyStorageState } from "@domain/storage/index.js";

import { getStorageConfig, objectExists, openStorageFolder } from "../fake/storage.js";
import { Badge, Button, useToast } from "./index.js";

function toWindowsPath(root: string, filePath: string): string {
  const separator = root.includes("/") && !root.includes("\\") ? "/" : "\\";
  const relative = filePath.split("/").join(separator);
  return `${root}${separator}Documents${separator}${relative}`;
}

export function StorageLocation({
  filePath,
  documentStorageRoot,
}: {
  filePath: string;
  /** The root recorded on this document at upload time
   * (`DocumentFile.storageRoot`) — lets a mismatch against the backend's
   * *current* root be told apart from a genuinely missing file. Undefined
   * for documents uploaded before this was tracked. */
  documentStorageRoot?: string;
}): ReactNode {
  const toast = useToast();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; root: string; exists: boolean }
    | { status: "unreachable" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([getStorageConfig(), objectExists(filePath)])
      .then(([config, exists]) => {
        if (!cancelled) setState({ status: "ready", root: config.root, exists });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unreachable" });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (state.status === "loading") {
    return <p className="text-xs text-ink-500">Locating file…</p>;
  }

  if (state.status === "unreachable") {
    return (
      <p className="text-xs text-red-700">
        Could not reach the local document storage backend. Run{" "}
        <code className="rounded bg-ink-100 px-1 py-0.5">npm run storage-server</code> and try again.
      </p>
    );
  }

  const fullPath = toWindowsPath(state.root, filePath);
  const fileState = classifyStorageState({
    ...(documentStorageRoot ? { documentStorageRoot } : {}),
    currentStorageRoot: state.root,
    exists: state.exists,
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-ink-700" title={fullPath}>
          {fullPath}
        </p>
        {fileState === "missing" && <Badge tone="bad">File missing on disk</Badge>}
        {fileState === "root-changed" && (
          <Badge tone="bad" title={`Uploaded under "${documentStorageRoot}"; storage is now configured to "${state.root}".`}>
            Storage root changed since upload
          </Badge>
        )}
      </div>
      {fileState === "root-changed" && (
        <p className="text-xs text-ink-500">
          This file was written to a different storage root than the one currently configured. It is
          most likely still on disk under the old root — this is not the same as the file having been
          deleted.
        </p>
      )}
      <Button
        onClick={() => {
          void openStorageFolder(filePath).then((result) => {
            if (!result.ok) toast.show(result.message ?? "Could not open the folder.", "bad");
          });
        }}
      >
        Open Folder
      </Button>
    </div>
  );
}
