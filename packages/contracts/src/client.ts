/**
 * Zero-Zod browser client entry for @open-split/contracts.
 * Keeps Zod runtime out of apps/web's JS bundle while sharing constants and API paths.
 */
export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_EXPENSE,
  GROUP_ATTACHMENT_QUOTA_BYTES,
  attachmentMimeTypes,
} from "./attachment-limits.ts";
export { apiPaths } from "./routes.ts";
