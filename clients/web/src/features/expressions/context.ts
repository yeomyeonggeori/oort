import { createContext, useContext, useSyncExternalStore } from "react";
import { emptyExpressionUsage } from "@momo/core/features/expressions/usage";
import type { ExpressionStore } from "./ExpressionStore";
export const ExpressionsContext = createContext<ExpressionStore | null>(null);
const emptySnapshot: ExpressionStore["snapshot"] = { usage: emptyExpressionUsage("", ""), cache: { workspaceId: "", memberId: "", version: null, items: [], addPolicy: "members" }, status: "ready", epoch: 0, offline: false };
const noopSubscribe = () => () => {};
export function useExpressions() {
  const store = useContext(ExpressionsContext);
  const snapshot = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getSnapshot ?? (() => emptySnapshot), () => emptySnapshot);
  return { store, ...snapshot };
}
