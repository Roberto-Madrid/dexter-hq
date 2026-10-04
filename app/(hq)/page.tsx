import { loadTowerSnapshot } from "../../hq/tower-load.ts";
import { CommandCenter } from "./command-center";

export const dynamic = "force-dynamic";

export default async function Page() {
  const snapshot = await loadTowerSnapshot();
  return <CommandCenter snapshot={snapshot} />;
}
