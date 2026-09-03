import { useQuery } from "@tanstack/react-query";
import { fetchAgentToolCatalog } from "@momo/core/lib/api";
import { useSession } from "@/app/session";

export function useAgentToolCatalog() {
  const { workspaceId } = useSession();
  return useQuery({
    queryKey: ["agent-tool-catalog", workspaceId.toLowerCase()],
    queryFn: ({ signal }) => fetchAgentToolCatalog(workspaceId, signal),
    retry: false,
    staleTime: 30_000,
  });
}
