import { ServiceError } from "../ledger/errors.ts";

/** Read a Request body up to maxBytes, aborting early if Content-Length or stream exceeds the limit. */
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes) {
      throw new ServiceError(413, "payload_too_large", "請求內容超過大小限制。");
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ServiceError(413, "payload_too_large", "請求內容超過大小限制。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
