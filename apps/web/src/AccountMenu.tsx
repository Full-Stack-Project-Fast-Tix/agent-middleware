import { useEffect, useId, useRef, useState } from "react";
import type { User } from "@launchpad/shared";
import { Button } from "./ui";

/** One or two letters for the avatar. Decoration: the name sits beside it or in the panel. */
function initials(name: string | undefined): string {
  if (name === undefined) return "";
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words;
  return letters.map((word) => [...word][0]!.toLocaleUpperCase()).join("");
}

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
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("button")?.focus();
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
    <div
      className={"account-menu" + (open ? " account-menu-open" : "")}
      ref={root}
      onBlur={(event) => {
        // Tabbing out of the panel closes it, like the Select.
        if (open && event.relatedTarget !== null && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="account-menu-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="avatar" aria-hidden="true">{initials(user?.name)}</span>
        <span className="account-menu-name">{user?.name ?? "Account"}</span>
        <svg className="account-menu-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.6 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="account-menu-panel" id={panelId} ref={panel}>
        {user !== null && (
          <div className="account-menu-who">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
        )}
        <Button className="account-menu-signout" variant="ghost" busy={busy} onClick={() => {
          setBusy(true);
          void onSignOut();
        }}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
