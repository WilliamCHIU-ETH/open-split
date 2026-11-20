import { DriverFailure } from "./failure.ts";

export function takeOption(args: readonly string[], name: string): { value: string | undefined; rest: string[] } {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) return { value: undefined, rest: [...args] };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new DriverFailure(1, `缺少 ${flag} 的值。`);
  }
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

export function takeFlag(args: readonly string[], name: string): { present: boolean; rest: string[] } {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) return { present: false, rest: [...args] };
  return { present: true, rest: [...args.slice(0, index), ...args.slice(index + 1)] };
}

export function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new DriverFailure(1, `缺少 --${name}。`);
  return value;
}

export function rejectUnknown(args: readonly string[]): void {
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown) throw new DriverFailure(1, `不認識的參數 ${unknown}。`);
}
