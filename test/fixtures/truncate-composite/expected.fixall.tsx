// The composite equivalences must be APPLIED by --fixall, not merely reported.
// Before the shared rule table existed the audit reported these forever and no
// fixer could ever clear them.
export const Truncated = () => (
    <div className="truncate block">truncate me</div>
);

// A same-prefix sibling that does not change the outcome must NOT block the
// collapse: overflow-visible wins over both overflow-hidden and truncate.
export const StillSafe = () => (
    <div className="truncate overflow-visible">still safe</div>
);

// A same-prefix sibling that DOES change the outcome must block it.
export const Blocked = () => (
    <div className="overflow-hidden text-ellipsis whitespace-nowrap whitespace-normal">blocked</div>
);

export const BlockedPlace = () => (
    <div className="content-center justify-center justify-between">blocked place</div>
);
