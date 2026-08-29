export async function pollOnce(fetchNext: () => Promise<void>): Promise<void> {
  setInterval(() => console.info("poll heartbeat"), 1_000);
  await fetchNext();
}
