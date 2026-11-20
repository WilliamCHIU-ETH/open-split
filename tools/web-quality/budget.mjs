import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const JS_GZIP_BUDGET = 150 * 1024;
const dist = join(fileURLToPath(new URL("../../apps/web/dist/assets", import.meta.url)));

let total = 0;
const files = [];
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".js")) continue;
  const bytes = readFileSync(join(dist, name));
  const gzip = gzipSync(bytes).length;
  total += gzip;
  files.push({ name, gzip });
}

if (files.length === 0) {
  console.error("apps/web/dist/assets 沒有 JS。請先建置。");
  process.exit(1);
}

const summary = files.map((file) => `${file.name}=${String(file.gzip)}`).join(", ");
if (total > JS_GZIP_BUDGET) {
  console.error(
    `apps/web JS gzip ${String(total)} bytes 超過預算 ${String(JS_GZIP_BUDGET)}。${summary}。` +
      "WHY: 帳本要在 LINE 內建瀏覽器裡打開。先加一套 UI 元件庫會直接吃掉這段預算。",
  );
  process.exit(1);
}

console.log(`web js gzip ok: ${String(total)} / ${String(JS_GZIP_BUDGET)} (${summary})`);
