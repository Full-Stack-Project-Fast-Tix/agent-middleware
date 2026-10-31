import { useEffect, useId, useRef, useState } from "react";
import type { User } from "@launchpad/shared";
import { Button } from "./ui";

/**
 * Who is signed in, and signing out. It stays usable if the account details did
 * not load, so nobody is left unable to sign out. The phone menu shows the panel
 * open, by CSS, because it is already inside a menu.
 */
export function AccountMenu({ user, onSignOut }: {
  user: Pick<User, "name" | "email"> | null;
  onSignOut: () => Promise<void>;
}) {
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={"account-menu" + (open ? " account-menu-open" : "")} ref={root}>
      <button
        ref={trigger}
        type="button"
        className="account-menu-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {user?.name ?? "Account"}
      </button>
      <div className="account-menu-panel" id={panelId}>
        {user !== null && (
          <div className="account-menu-who">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
        )}
        <Button busy={busy} onClick={() => {
          setBusy(true);
          void onSignOut();
        }}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
