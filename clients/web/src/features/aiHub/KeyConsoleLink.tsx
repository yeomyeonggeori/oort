import { ExternalLink } from "lucide-react";
import { CONSOLE_BILLING, limitsCompanyOf } from "@momo/core/features/settings/keyLimits";

// =============================================================================
// 키 줄 아래의 「콘솔에서 크레딧 보기」 링크 한 줄 (#4110).
//
// Anthropic·OpenAI는 일반 API 키로 잔액·한도를 알려 주지 않는다. 그래서 oort는 숫자를 보이지
// 않고(공급사 숫자·oort 추정·월 크레딧 입력을 걷었다), 정확한 잔액이 있는 공급사 결제 화면으로만
// 보낸다. 모르는 주소(사내 프록시 등)는 보낼 곳이 없으니 아무것도 그리지 않는다.
// =============================================================================

export function KeyConsoleLink({ testId, baseUrl }: { testId: string; baseUrl: string }) {
  const company = limitsCompanyOf(baseUrl);
  if (company === null) return null;
  const link = CONSOLE_BILLING[company];
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="tap-target press inline-flex w-max items-center gap-1 rounded-md text-meta font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:text-ink-muted focus-visible:focus-ring"
      data-testid={testId}
    >
      {link.label}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}
