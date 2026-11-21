import { formatMinorByCurrency, formatMinorDecimal, minor } from "@open-split/core";

export function formatMoney(minorText: string, currency: string): string {
  try {
    return formatMinorByCurrency(minor(BigInt(minorText)), currency);
  } catch {
    const negative = minorText.startsWith("-");
    const digits = negative ? minorText.slice(1) : minorText;
    const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${negative ? "−" : ""}${grouped} ${currency}`;
  }
}

export function formatDecimalInput(minorText: string, currency: string): string {
  try {
    return formatMinorDecimal(minor(BigInt(minorText)), currency);
  } catch {
    return minorText;
  }
}

export function formatRateDisplay(rate: { numerator: number; denominator: number } | null): string {
  if (!rate) return "";
  if (rate.denominator === 1) return String(rate.numerator);
  return `${String(rate.numerator)}/${String(rate.denominator)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${String(bytes)} B`;
}

export function netTone(net: string): "owed" | "owes" | "even" {
  if (net === "0") return "even";
  if (net.startsWith("-")) return "owes";
  return "owed";
}

export function netLabel(tone: "owed" | "owes" | "even"): string {
  if (tone === "owed") return "應收";
  if (tone === "owes") return "應付";
  return "兩不相欠";
}

export function splitLabel(type: "equal" | "exact" | "percentage" | "shares"): string {
  if (type === "exact") return "指定金額";
  if (type === "percentage") return "百分比";
  if (type === "shares") return "份數";
  return "平均";
}

export function memberStatus(member: { role: "owner" | "member"; virtual: boolean; claimedAt: string | null }): string {
  if (member.virtual) return "尚未註冊";
  if (member.claimedAt) return "已認領";
  if (member.role === "owner") return "擁有者";
  return "已加入";
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-Hant-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
