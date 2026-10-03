import { CommandCenter } from "./command-center";
import { getBoard } from "../generated/hq.js";

export const dynamic = "force-dynamic";

export default async function Page() {
  const board = await getBoard();
  return <CommandCenter initial={board} />;
}
