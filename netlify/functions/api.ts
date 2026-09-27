import type { Config } from "@netlify/functions";
import { blobStore } from "../../src/server/blob-store";
import { handle } from "../../src/server/core";

export default (req: Request) => handle(req, blobStore());

export const config: Config = {
  path: "/api/*",
};
