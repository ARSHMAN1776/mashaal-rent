/**
 * The small key-value storage the app needs. Online it is Netlify Blobs
 * (blob-store.ts); on your own computer it is a folder of JSON files (file-store.ts).
 */
export interface KV {
  read<T>(key: string): Promise<{ value: T | null; etag: string | null }>;
  /**
   * Saves only if nobody changed the entry since it was read: `etag` must still
   * match, or be null when the entry must not exist yet. Returns false otherwise.
   */
  write(key: string, value: unknown, etag: string | null): Promise<boolean>;
  /** Saves without checking. */
  put(key: string, value: unknown): Promise<void>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
}
