import { Button } from "@/design/ui/button";
import { useSession } from "@/app/session";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { KeyValueRows, SectionShell } from "./SettingsFields";

// =============================================================================
// 계정 (R-1 §5): the one section every member sees. Identity comes from the
// roster when it has loaded and from the login response otherwise, so the panel
// renders the same either way instead of blanking while the roster arrives.
// =============================================================================

export function AccountSection() {
  const { session, workspaceId, logout } = useSession();
  const { directory } = useDirectory(workspaceId);
  const me = memberFor(directory, session.member.id);

  return (
    <SectionShell
      title="계정"
      lines={["이 서버에서 나를 가리키는 정보입니다."]}
    >
      <KeyValueRows
        rows={[
          { key: "이름", value: me?.displayName ?? session.member.displayName },
          { key: "핸들", value: `@${me?.handle ?? session.member.handle}` },
          { key: "워크스페이스 ID", value: workspaceId, numeric: true },
          { key: "멤버 ID", value: session.member.id, numeric: true },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={logout} data-testid="logout">
          로그아웃
        </Button>
      </div>
    </SectionShell>
  );
}
