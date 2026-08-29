import { pollOnce } from "./worker.js";

export async function runCycle(fetchNext: () => Promise<void>): Promise<void> {
  await pollOnce(fetchNext);
}
