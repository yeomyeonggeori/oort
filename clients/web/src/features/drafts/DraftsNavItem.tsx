import { FileText } from "lucide-react";
import { SidebarRow } from "@/features/sidebar/SidebarRow";
import { useDraftsPanel } from "./useDraftsPanel";

/** 인박스 옆 「초안」. 0개면 숨긴다. */
export function DraftsNavItem() {
  const { showNav } = useDraftsPanel();
  if (!showNav) return null;
  return (
    <SidebarRow
      to="/drafts"
      icon={<FileText className="size-4" />}
      label="초안"
      testId="nav-drafts"
    />
  );
}
