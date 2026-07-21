import type { ArtifactPresentation, DiffLineKind } from "../timeline/artifacts";

const LINE_LABEL: Record<DiffLineKind, string> = {
  addition: "추가",
  deletion: "삭제",
  hunk: "변경 구간",
  metadata: "diff 메타데이터",
  context: "문맥",
};

function ChangeSummary({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span
      className="artifact-change-summary"
      aria-label={`${additions} additions, ${deletions} deletions`}
    >
      <span className="artifact-addition">+{additions}</span>{" "}
      <span className="artifact-deletion">−{deletions}</span>
    </span>
  );
}

export default function ArtifactCard({
  presentation,
}: {
  presentation: ArtifactPresentation;
}) {
  if (presentation.kind !== "diff") {
    return (
      <article className="artifact-card artifact-link-card">
        <header className="artifact-card-header">
          <strong>{presentation.title}</strong>
          <span className="message-type-badge">
            {presentation.kind === "commit" ? "COMMIT" : "PR"}
          </span>
        </header>
        <div className="artifact-metadata">
          {presentation.repository && <span>저장소 {presentation.repository}</span>}
          {presentation.branch && <span>브랜치 {presentation.branch}</span>}
          {presentation.status && <span>상태 {presentation.status}</span>}
        </div>
        {presentation.url && (
          <a href={presentation.url} target="_blank" rel="noreferrer">
            브라우저에서 열기
          </a>
        )}
      </article>
    );
  }

  return (
    <article
      className="artifact-card artifact-diff-card"
      aria-label={`${presentation.title}, ${presentation.files.length} files, ${presentation.additions} additions, ${presentation.deletions} deletions`}
    >
      <header className="artifact-card-header">
        <strong>{presentation.title}</strong>
        <ChangeSummary
          additions={presentation.additions}
          deletions={presentation.deletions}
        />
      </header>
      {presentation.files.map((file) => (
        <details className="artifact-diff-file" key={file.id}>
          <summary>
            <code>{file.path}</code>
            <ChangeSummary
              additions={file.additions}
              deletions={file.deletions}
            />
          </summary>
          <pre className="artifact-diff-lines">
            {file.lines.map((line) => (
              <code
                key={line.id}
                className={`artifact-diff-line artifact-diff-${line.kind}`}
                aria-label={`${LINE_LABEL[line.kind]}: ${line.text}`}
              >
                {line.text === "" ? " " : line.text}{"\n"}
              </code>
            ))}
          </pre>
        </details>
      ))}
    </article>
  );
}
