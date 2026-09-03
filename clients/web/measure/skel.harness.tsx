import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EmptyInvite, Skeleton } from "@/features/common/States";

/**
 * UX-R1c browser probe. Not a product route. Lives under measure/ so a
 * module-scope createRoot cannot become a second React root over the app.
 * Call-site shape: bars → content, `ready` flipped through React state.
 *
 * Two product shapes share the page so the height-trace cases can sample
 * Drafts-empty and the sidebar 2-channel list on the real `Skeleton`.
 * `skel-arrive` stays on the sidebar shape (existing React cases).
 */
function SidebarShape() {
  const [ready, setReady] = useState(false);

  const handleArrive = () => {
    setReady(true);
  };

  return (
    <section data-skel-shape="sidebar">
      <button type="button" data-testid="skel-arrive" onClick={handleArrive}>
        도착
      </button>
      <Skeleton ready={ready} rows={4}>
        <ul className="flex flex-col">
          <li className="px-2 py-1 text-body">엔진</li>
          <li className="px-2 py-1 text-body">일반</li>
        </ul>
      </Skeleton>
    </section>
  );
}

function DraftsShape() {
  const [ready, setReady] = useState(false);

  const handleArrive = () => {
    setReady(true);
  };

  return (
    <section data-skel-shape="drafts">
      <button
        type="button"
        data-testid="skel-arrive-drafts"
        onClick={handleArrive}
      >
        도착
      </button>
      <Skeleton ready={ready} rows={4} className="p-4">
        <EmptyInvite
          headline="아직 초안이 없습니다."
          detail="쓰다 만 글은 자동으로 저장됩니다."
          testId="drafts-empty"
        />
      </Skeleton>
    </section>
  );
}

export function Harness() {
  return (
    <div>
      <SidebarShape />
      <DraftsShape />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("skel harness: #root missing");
createRoot(root).render(<Harness />);
