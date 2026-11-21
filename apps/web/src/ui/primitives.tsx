import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "../router";

type ButtonVariant = "secondary" | "primary" | "ghost" | "danger";

function buttonClass(variant: ButtonVariant, page: boolean, extra?: string): string {
  return [
    "button",
    variant === "secondary" ? null : "button-" + variant,
    page ? "button-page" : null,
    extra,
  ].filter(Boolean).join(" ");
}

export function Button({ variant = "secondary", page = false, busy = false, className, children, disabled, type = "button", ...rest }: {
  variant?: ButtonVariant;
  /** The 40px height, for the one main action of a page. */
  page?: boolean;
  /** Disables the button and shows a spinner beside its label. */
  busy?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} type={type} className={buttonClass(variant, page, className)} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** A link that looks like a button, for actions that are really navigation. */
export function ButtonLink({ to, variant = "secondary", page = false, children }: {
  to: string;
  variant?: ButtonVariant;
  page?: boolean;
  children: ReactNode;
}) {
  return <Link to={to} className={buttonClass(variant, page)}>{children}</Link>;
}

/**
 * Anything an agent or a repository wrote: narration, reports, commands, paths,
 * diffs, tool output, handoff text. The label and note are trusted, written by
 * this app; only the children are foreign. Render it as text or through
 * MessageContent, never as raw HTML.
 */
export function Foreign({ label, note, preformatted = false, maxHeight, children }: {
  /** Whose words these are, for instance "Agent's report". */
  label?: ReactNode;
  /** What AgentGuard can and cannot say about them, for instance "Written by the agent, not checked by AgentGuard". */
  note?: ReactNode;
  /** Keep whitespace and line breaks: commands, output and diffs. */
  preformatted?: boolean;
  /** Scroll inside the block beyond this height, in pixels. */
  maxHeight?: number;
  children: ReactNode;
}) {
  const surface = (
    <div className={preformatted ? "foreign foreign-pre" : "foreign"} style={maxHeight === undefined ? undefined : { maxHeight }}>
      {children}
    </div>
  );
  if (label === undefined && note === undefined) return surface;
  return (
    <div className="foreign-block">
      <div className="foreign-caption">
        {label !== undefined && <strong>{label}</strong>}
        {note !== undefined && <span>{note}</span>}
      </div>
      {surface}
    </div>
  );
}

/** A path, command or id written by an agent, inside a trusted sentence. */
export function ForeignInline({ children }: { children: ReactNode }) {
  return <code className="foreign-inline">{children}</code>;
}

/**
 * The table frame. Write ordinary thead/tbody/tr/th/td inside. Use
 * `className="num"` on times and counts, and `className="cell-prompt"` on a long
 * text cell that should truncate. Wide tables scroll inside themselves.
 */
export function DataTable({ caption, children }: {
  /** Names the table for screen readers. */
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="data-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

/** An empty view is an invitation: say what to do next and offer the action. */
export function EmptyState({ title, children, action }: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="state-empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="state-empty-action">{action}</div>}
    </div>
  );
}

/** Say what went wrong and how to fix it. Errors do not apologise. */
export function ErrorState({ title = "This did not load", message, onRetry, retryLabel = "Try again" }: {
  title?: string;
  message: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="state-error" role="alert">
      <strong>{title}</strong>
      <div>{message}</div>
      {onRetry && <Button onClick={onRetry}>{retryLabel}</Button>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        <h1>{title}</h1>
        {description && <p className="meta">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}
