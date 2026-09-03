import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Skeleton } from "@/features/common/States";

/**
 * UX-R1c browser probe. Not a product route. Lives under measure/ so a
 * module-scope createRoot cannot become a second React root over the app.
 * Call-site shape: bars → content, `ready` flipped through React state.
 */
export function Harness() {
  const [ready, setReady] = useState(false);

  const handleArrive = () => {
    setReady(true);
  };

  return (
    <div>
      <button type="button" data-testid="skel-arrive" onClick={handleArrive}>
        도착
      </button>
      <Skeleton ready={ready} rows={4}>
        <ul className="flex flex-col">
          <li className="px-2 py-1 text-body">엔진</li>
          <li className="px-2 py-1 text-body">일반</li>
        </ul>
      </Skeleton>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("skel harness: #root missing");
createRoot(root).render(<Harness />);
