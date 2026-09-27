import { getStore } from "@netlify/blobs";
import type { KV } from "./kv";

/** Netlify Blobs storage. Site-wide, so data survives every new deploy. */
export function blobStore(): KV {
  const store = getStore({ name: "mashaal-rent", consistency: "strong" });
  return {
    async read(key) {
      const entry = await store.getWithMetadata(key, { type: "json" });
      return entry ? { value: entry.data, etag: entry.etag ?? null } : { value: null, etag: null };
    },
    async write(key, value, etag) {
      const result = etag
        ? await store.setJSON(key, value, { onlyIfMatch: etag })
        : await store.setJSON(key, value, { onlyIfNew: true });
      return result.modified;
    },
    async put(key, value) {
      await store.setJSON(key, value);
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map(b => b.key);
    },
    async remove(key) {
      await store.delete(key);
    },
  };
}
