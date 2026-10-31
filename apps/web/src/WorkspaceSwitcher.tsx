import { useCurrentWorkspace } from "./useCurrentWorkspace";

/** Plain text for one workspace, a real select for several. Pages show any load error. */
export function WorkspaceSwitcher() {
  const { workspaces, current, select } = useCurrentWorkspace();
  if (workspaces === null || current === null) return null;
  if (workspaces.length === 1) {
    return (
      <div className="workspace-switcher">
        <span className="workspace-switcher-label">Workspace</span>
        <span className="workspace-switcher-name" title={current.name}>{current.name}</span>
      </div>
    );
  }
  return (
    <label className="workspace-switcher">
      <span className="workspace-switcher-label">Workspace</span>
      <select value={current.id} onChange={(event) => select(event.target.value)}>
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
        ))}
      </select>
    </label>
  );
}
