import { MessageContent } from "../MessageContent";
import { EmptyState, ErrorState, Loading, PageHeader } from "../ui";
import { useLoad } from "./shared";
import { workspaceApi } from "./workspace-api";

/** Saved reports, newest first. Results come from running the benchmark, never from this page. */
export function BenchmarksPage() {
  const { data, error, refresh } = useLoad("benchmarks", () => workspaceApi.benchmarks());
  return (
    <div className="page">
      <PageHeader title="Benchmarks" description="Saved evaluation reports: how the guards did against attack and benign scenarios." />
      {data === null ? (
        error !== null ? <ErrorState message={error} onRetry={() => void refresh()} /> : <Loading label="Loading reports" />
      ) : data.length === 0 ? (
        <EmptyState title="No benchmark reports on this server">Run the benchmark, then its report appears here.</EmptyState>
      ) : (
        data.map((result) => (
          <section key={result.name} className="page-section">
            <h2>{result.name}</h2>
            <MessageContent content={result.report} rich />
          </section>
        ))
      )}
    </div>
  );
}
