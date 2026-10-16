import type { SandboxReviewRequest } from "../classifier.js";
import type { FilesystemList, ListOp, SandboxPolicy } from "../config.js";
import type { SandboxEventReason } from "../runtime.js";

export type PermissionList = FilesystemList | "network-allow" | "mach-lookup";

interface PermissionDetails {
  policy: SandboxPolicy;
  target: string;
  command?: string;
  cwd: string;
  operation: string;
  reason: SandboxEventReason;
  alreadyApplied: boolean;
  autoRetryAvailable: boolean;
}

interface AutomaticReview {
  permission: SandboxReviewRequest["permission"];
  evidence?: string;
}

type PermissionAction<List extends PermissionList> = { list: List; op: ListOp; value: string };
type RetryReview = AutomaticReview & { config: SandboxPolicy };

/** Detection nominates a capability. Only the shared resolver can authorize it. */
export type PermissionProposal = PermissionDetails &
  (
    | {
        kind: "network";
        action: PermissionAction<"network-allow">;
        automatic?: AutomaticReview;
      }
    | {
        kind: "filesystem";
        action: PermissionAction<FilesystemList>;
        automatic?: RetryReview;
      }
    | {
        kind: "mach-lookup";
        action: PermissionAction<"mach-lookup">;
        automatic?: RetryReview;
      }
  );

export interface TemporaryPermissionGrant {
  config: SandboxPolicy;
  policy: SandboxPolicy;
  onStalePolicy: () => void;
}
