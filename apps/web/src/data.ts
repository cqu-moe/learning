import { useRouteLoaderData } from "react-router";
import type { Dashboard } from "../shared/contracts.ts";

export function useDashboard(): Dashboard {
  return useRouteLoaderData("workspace") as Dashboard;
}
