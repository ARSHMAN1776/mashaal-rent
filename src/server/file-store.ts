import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KV } from "./kv";

/** JSON files in a folder. Used only when testing on your own computer. */
export function fileStore(folder: string): KV {
  const fileFor = (key: string) => join(folder, key.replaceAll("/", "__") + ".json");
  const keyFor = (file: string) => file.slice(0, -".json".length).replaceAll("__", "/");
  const hash = (text: string) => createHash("sha1").update(text).digest("hex");

  async function readText(key: string): Promise<string | null> {
    try {
      return await readFile(fileFor(key), "utf8");
    } catch {
      return null;
    }
  }

  async function save(key: string, value: unknown) {
    await mkdir(folder, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify(value), "utf8");
  }

  return {
    async read(key) {
      const text = await readText(key);
      return text === null ? { value: null, etag: null } : { value: JSON.parse(text), etag: hash(text) };
    },
    async write(key, value, etag) {
      const text = await readText(key);
      const current = text === null ? null : hash(text);
      if (current !== etag) return false;
      await save(key, value);
      return true;
    },
    put: save,
    async list(prefix) {
      const files = await readdir(folder).catch(() => [] as string[]);
      return files.filter(f => f.endsWith(".json")).map(keyFor).filter(k => k.startsWith(prefix));
    },
    async remove(key) {
      await rm(fileFor(key), { force: true });
    },
  };
}
