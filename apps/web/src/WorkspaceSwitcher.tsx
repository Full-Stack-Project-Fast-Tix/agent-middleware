import { Select } from "./ui";
import { useCurrentWorkspace } from "./useCurrentWorkspace";

/** Plain text for one workspace, a dropdown for several. Pages show any load error. */
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
    <div className="workspace-switcher">
      <Select
        label="Workspace"
        quiet
        value={current.id}
        onChange={select}
        options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
      />
    </div>
  );
}
