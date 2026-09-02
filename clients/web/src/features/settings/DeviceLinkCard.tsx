import { Button } from "@/design/ui/button";

/**
 * Stub for the #1989 red proofs. The GREEN commit replaces this with the
 * QR / SAS / connected card.
 */
export function DeviceLinkCard({ offline: _offline }: { offline?: boolean }) {
  return (
    <div
      className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4 shadow-sm"
      data-testid="device-link-card"
    >
      <h3 className="text-body font-semibold text-ink">폰 연결</h3>
      <p className="break-keep text-body text-ink-muted">
        이 계정을 폰에서도 쓰려면 QR을 만드세요.
      </p>
      <Button type="button" size="sm" data-testid="device-link-create">
        QR 만들기
      </Button>
    </div>
  );
}
