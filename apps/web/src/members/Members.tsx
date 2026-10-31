import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkspaceMemberSummary, WorkspaceMembersResponse, WorkspaceRole } from "@launchpad/shared";
import { paths } from "../router";
import { Button, ButtonLink, DataTable, EmptyState, ErrorState, Loading, PageHeader } from "../ui";
import { useCurrentWorkspace } from "../useCurrentWorkspace";
import {
  changeErrorMessage,
  isOnlyAdmin,
  listErrorMessage,
  removeWarning,
  ROLE_DUTIES,
  ROLE_WORDS,
  roleChangeWarning,
  ROLES,
} from "./member-view";
import { membersApi } from "./members-api";

type Confirming =
  | { kind: "role"; member: WorkspaceMemberSummary; role: WorkspaceRole; message: string }
  | { kind: "remove"; member: WorkspaceMemberSummary; message: string };

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function RoleOptions() {
  return ROLES.map((role) => <option key={role} value={role}>{ROLE_WORDS[role]}</option>);
}

/** Shown in token mode, where these routes do not exist. No request is made. */
export function MembersUnavailable() {
  return (
    <div className="page">
      <PageHeader title="Members" />
      <EmptyState
        title="Members need password sign-in"
        action={<ButtonLink to={paths.dashboard}>Go to the dashboard</ButtonLink>}
      >
        This server uses one shared access token, so it has no individual accounts to manage.
      </EmptyState>
    </div>
  );
}

/**
 * Who can open the current workspace. A security admin can also change the list.
 * Accounts themselves are created on the command line, not here.
 */
export function Members({ viewerId }: { viewerId: string | null }) {
  const { workspaces, current, error: workspacesError, reload: reloadWorkspaces } = useCurrentWorkspace();
  // "You left" has to outlive the page for the workspace that was left.
  const [carriedNotice, setCarriedNotice] = useState<string | null>(null);
  const clearCarriedNotice = useCallback(() => setCarriedNotice(null), []);
  const left = useCallback((message: string) => {
    setCarriedNotice(message);
    reloadWorkspaces();
  }, [reloadWorkspaces]);

  if (workspacesError !== null) {
    return (
      <div className="page">
        <PageHeader title="Members" />
        <ErrorState message={`The list of workspaces did not load: ${workspacesError}`} onRetry={reloadWorkspaces} />
      </div>
    );
  }
  if (workspaces === null) return <div className="page"><PageHeader title="Members" /><Loading label="Loading workspaces" /></div>;
  if (current === null) {
    return (
      <div className="page">
        <PageHeader title="Members" />
        {carriedNotice !== null && <p className="members-notice" role="status">{carriedNotice}</p>}
        <EmptyState title="You are not in a workspace yet">
          Ask a security admin to add you to their workspace, or your platform operator to create one.
        </EmptyState>
      </div>
    );
  }
  // Keyed by workspace: a slow answer about the last one goes to a page that is gone.
  return (
    <WorkspaceMembers
      key={current.id}
      workspaceId={current.id}
      workspaceName={current.name}
      viewerId={viewerId}
      reloadWorkspaces={reloadWorkspaces}
      initialNotice={carriedNotice}
      onNoticeShown={clearCarriedNotice}
      onLeft={left}
    />
  );
}

function WorkspaceMembers({ workspaceId, workspaceName, viewerId, reloadWorkspaces, initialNotice, onNoticeShown, onLeft }: {
  workspaceId: string;
  workspaceName: string;
  viewerId: string | null;
  reloadWorkspaces: () => void;
  initialNotice: string | null;
  onNoticeShown: () => void;
  onLeft: (message: string) => void;
}) {
  const [list, setList] = useState<WorkspaceMembersResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("developer");
  const [adding, setAdding] = useState(false);

  const latestLoad = useRef(0);
  const mounted = useRef(true);
  const status = useRef<HTMLParagraphElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const focusAfterConfirm = useRef<string | null>(null);

  const load = useCallback(async () => {
    const attempt = ++latestLoad.current;
    try {
      const next = await membersApi.list(workspaceId);
      if (attempt !== latestLoad.current) return;
      setList(next);
      setListError(null);
    } catch (reason) {
      if (attempt !== latestLoad.current) return;
      setList(null);
      setListError(listErrorMessage(reason));
    }
  }, [workspaceId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      latestLoad.current += 1;
    };
  }, [load]);

  // Only the page that opened with the notice clears it, not the one being left.
  const [openedWithNotice] = useState(initialNotice !== null);
  useEffect(() => {
    if (openedWithNotice) onNoticeShown();
  }, [openedWithNotice, onNoticeShown]);

  // A closed confirmation gives focus back to the control that opened it.
  useEffect(() => {
    if (confirming !== null || focusAfterConfirm.current === null) return;
    document.getElementById(focusAfterConfirm.current)?.focus();
    focusAfterConfirm.current = null;
  }, [confirming]);

  const canManage = list?.viewerRole === "security_admin";

  const changeRole = async (member: WorkspaceMemberSummary, next: WorkspaceRole) => {
    setConfirming(null);
    setActionError(null);
    setNotice(null);
    setBusyUserId(member.userId);
    try {
      await membersApi.changeRole(workspaceId, member.userId, next);
      setNotice(
        member.userId === viewerId
          ? `Changed your role to ${ROLE_WORDS[next]}.`
          : `Changed ${member.name} to ${ROLE_WORDS[next]}.`,
      );
    } catch (reason) {
      setActionError(changeErrorMessage("change", reason));
    } finally {
      setBusyUserId(null);
    }
    if (!mounted.current) return;
    await load();
    focusAfterConfirm.current = null;
    if (mounted.current) document.getElementById(`member-role-${member.userId}`)?.focus();
  };

  const remove = async (member: WorkspaceMemberSummary) => {
    setConfirming(null);
    setActionError(null);
    setNotice(null);
    setBusyUserId(member.userId);
    const leaving = member.userId === viewerId;
    try {
      await membersApi.remove(workspaceId, member.userId);
      setNotice(leaving ? `You left ${workspaceName}.` : `Removed ${member.name}.`);
      if (leaving) {
        onLeft(`You left ${workspaceName}.`);
        return;
      }
    } catch (reason) {
      setActionError(changeErrorMessage("change", reason));
    } finally {
      setBusyUserId(null);
    }
    if (!mounted.current) return;
    await load();
    focusAfterConfirm.current = null;
    status.current?.focus();
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setActionError(null);
    setNotice(null);
    setAdding(true);
    try {
      const member = await membersApi.add(workspaceId, { email: email.trim(), role });
      setNotice(`Added ${member.name} as ${ROLE_WORDS[member.role]}.`);
      setEmail("");
      setRole("developer");
    } catch (reason) {
      setActionError(changeErrorMessage("add", reason));
    } finally {
      setAdding(false);
    }
    if (!mounted.current) return;
    await load();
    emailInput.current?.focus();
  };

  const askToChangeRole = (member: WorkspaceMemberSummary, next: WorkspaceRole) => {
    if (next === member.role) return;
    const message = roleChangeWarning(member, next, viewerId);
    if (message === null) {
      void changeRole(member, next);
      return;
    }
    focusAfterConfirm.current = `member-role-${member.userId}`;
    setConfirming({ kind: "role", member, role: next, message });
  };

  return (
    <div className="page members-page">
      <PageHeader title="Members" description={`People who can open ${workspaceName}.`} />

      {listError !== null ? (
        <ErrorState message={listError} onRetry={() => {
          reloadWorkspaces();
          void load();
        }} />
      ) : list === null ? (
        <Loading label="Loading members" />
      ) : (
        <>
          {!canManage && (
            <p className="members-readonly">
              You are {list.viewerRole === "auditor" ? "an" : "a"} {ROLE_WORDS[list.viewerRole]} here, so you can see this list.
              Only a security admin can change it.
            </p>
          )}

          <div className="members-feedback">
            {actionError !== null && (
              <div className="members-error" role="alert">
                <span>{actionError}</span>
                <Button variant="ghost" onClick={() => setActionError(null)}>Dismiss</Button>
              </div>
            )}
            <p className="members-notice" role="status" tabIndex={-1} ref={status} hidden={notice === null}>{notice}</p>
          </div>

          <section className="page-section members-table">
            <DataTable caption="Workspace members">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Joined</th>
                  {canManage && <th><span className="sr-only">Remove</span></th>}
                </tr>
              </thead>
              <tbody>
                {list.members.map((member) => {
                  const you = member.userId === viewerId;
                  const onlyAdmin = isOnlyAdmin(list.members, member);
                  const open = confirming?.member.userId === member.userId ? confirming : null;
                  const busy = busyUserId === member.userId;
                  return (
                    <MemberRows
                      key={member.userId}
                      member={member}
                      you={you}
                      canManage={canManage}
                      onlyAdmin={onlyAdmin}
                      busy={busy}
                      confirming={open}
                      onRole={(next) => askToChangeRole(member, next)}
                      onRemove={() => {
                        focusAfterConfirm.current = `member-remove-${member.userId}`;
                        setConfirming({ kind: "remove", member, message: removeWarning(member, viewerId) });
                      }}
                      onKeep={() => setConfirming(null)}
                      onConfirm={() => {
                        if (open === null) return;
                        if (open.kind === "role") void changeRole(member, open.role);
                        else void remove(member);
                      }}
                    />
                  );
                })}
              </tbody>
            </DataTable>
          </section>

          {canManage && (
            <section className="page-section">
              <h2>Add a member</h2>
              <form className="members-add" onSubmit={(event) => void add(event)}>
                <label>
                  Email
                  <input
                    ref={emailInput}
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Role
                  <select value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
                    <RoleOptions />
                  </select>
                </label>
                <Button type="submit" variant="primary" busy={adding} disabled={!email.trim()}>Add member</Button>
              </form>
              <p className="meta">
                They need an account first. Accounts are created on the command line, so ask your platform operator
                for anyone who does not have one yet.
              </p>
            </section>
          )}

          <section className="page-section">
            <h2>What each role can do with runs and members</h2>
            <dl className="members-roles">
              {ROLES.map((item) => (
                <div key={item}>
                  <dt>{ROLE_WORDS[item]}</dt>
                  <dd>{ROLE_DUTIES[item]}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </div>
  );
}

function MemberRows({ member, you, canManage, onlyAdmin, busy, confirming, onRole, onRemove, onKeep, onConfirm }: {
  member: WorkspaceMemberSummary;
  you: boolean;
  canManage: boolean;
  onlyAdmin: boolean;
  busy: boolean;
  confirming: Confirming | null;
  onRole: (role: WorkspaceRole) => void;
  onRemove: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const fixed = !canManage || onlyAdmin;
  return (
    <>
      <tr className="member-row">
        <td className="member-person">
          <strong>{member.name}</strong>
          {you && <span className="member-you">You</span>}
          <span className="meta member-email">{member.email}</span>
        </td>
        <td className="member-role">
          {fixed ? (
            <>
              {ROLE_WORDS[member.role]}
              {canManage && onlyAdmin && (
                <span className="meta member-only-admin">
                  The only security admin. Make someone else one to change this.
                </span>
              )}
            </>
          ) : (
            <select
              id={`member-role-${member.userId}`}
              aria-label={`Role for ${member.name}`}
              value={confirming?.kind === "role" ? confirming.role : member.role}
              disabled={busy || confirming !== null}
              onChange={(event) => onRole(event.target.value as WorkspaceRole)}
            >
              <RoleOptions />
            </select>
          )}
        </td>
        <td className="num member-joined"><time dateTime={member.joinedAt}>{formatDate(member.joinedAt)}</time></td>
        {canManage && (
          <td className="member-actions">
            {!onlyAdmin && (
              <Button
                id={`member-remove-${member.userId}`}
                variant="ghost"
                aria-label={`Remove ${member.name}`}
                disabled={busy || confirming !== null}
                onClick={onRemove}
              >
                Remove
              </Button>
            )}
          </td>
        )}
      </tr>
      {confirming !== null && (
        <tr className="member-confirm">
          <td colSpan={4}>
            <div role="group" aria-label={`Confirm the change to ${member.name}`}>
              <span>{confirming.message}</span>
              <Button autoFocus onClick={onKeep}>{confirming.kind === "remove" ? "Keep member" : "Keep role"}</Button>
              {confirming.kind === "remove"
                ? <Button variant="danger" onClick={onConfirm}>Remove</Button>
                : <Button variant="danger" onClick={onConfirm}>Change role</Button>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
