import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EmptyInvite, Skeleton } from "@/features/common/States";

/**
 * UX-R1c browser probe. Not a product route. Lives under measure/ so a
 * module-scope createRoot cannot become a second React root over the app.
 * Call-site shape: bars → content, `ready` flipped through React state.
 *
 * Product shapes share the page so the height-trace cases can sample
 * Drafts-empty (shrink), sidebar 2-channel (shrink), and sidebar 5/12
 * (grow: bars=4 rows, content taller) on the real `Skeleton`.
 * `skel-arrive` stays on the 2-channel shape (existing React cases).
 */

const CHANNELS_2 = ["엔진", "일반"] as const;
const CHANNELS_5 = [
  "엔진",
  "일반",
  "디자인 시스템",
  "release-train",
  "고객-피드백",
] as const;
const CHANNELS_12 = [
  ...CHANNELS_5,
  "배포",
  "온보딩",
  "인프라",
  "법무",
  "제품",
  "리서치",
  "qa-nightly",
] as const;

function ChannelList({ names }: { names: readonly string[] }) {
  return (
    <ul className="flex flex-col">
      {names.map((name) => (
        <li key={name} className="px-2 py-1 text-body">
          {name}
        </li>
      ))}
    </ul>
  );
}

function SidebarShape({
  shape,
  arrive,
  names,
}: {
  shape: string;
  arrive: string;
  names: readonly string[];
}) {
  const [ready, setReady] = useState(false);

  const handleArrive = () => {
    setReady(true);
  };

  return (
    <section data-skel-shape={shape}>
      <button type="button" data-testid={arrive} onClick={handleArrive}>
        도착
      </button>
      <Skeleton ready={ready} rows={4}>
        {ready ? <ChannelList names={names} /> : null}
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
        {ready ? (
          <EmptyInvite
            headline="아직 초안이 없습니다."
            detail="쓰다 만 글은 자동으로 저장됩니다."
            testId="drafts-empty"
          />
        ) : null}
      </Skeleton>
    </section>
  );
}

export function Harness() {
  return (
    <div>
      <SidebarShape
        shape="sidebar"
        arrive="skel-arrive"
        names={CHANNELS_2}
      />
      <SidebarShape
        shape="sidebar5"
        arrive="skel-arrive-sidebar5"
        names={CHANNELS_5}
      />
      <SidebarShape
        shape="sidebar12"
        arrive="skel-arrive-sidebar12"
        names={CHANNELS_12}
      />
      <DraftsShape />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("skel harness: #root missing");
createRoot(root).render(<Harness />);
