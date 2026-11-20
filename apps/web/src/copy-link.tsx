import { useEffect, useId, useRef } from "react";

const timers = new WeakMap<HTMLButtonElement, number>();
let lastMessage = "";

function report(button: HTMLButtonElement, ok: boolean): void {
  const tip = button.nextElementSibling;
  if (!(tip instanceof HTMLElement)) return;
  const pending = timers.get(button);
  if (pending !== undefined) window.clearTimeout(pending);
  button.removeAttribute("data-copied");
  button.removeAttribute("data-failed");
  let message = ok ? "已複製" : "沒有複製";
  if (message === lastMessage) message += "\u00A0";
  lastMessage = message;
  tip.textContent = "";
  void button.offsetWidth;
  button.setAttribute(ok ? "data-copied" : "data-failed", "");
  window.requestAnimationFrame(() => {
    tip.textContent = message;
  });
  timers.set(
    button,
    window.setTimeout(() => {
      button.removeAttribute("data-copied");
      button.removeAttribute("data-failed");
      tip.textContent = "";
    }, 2000),
  );
}

async function writeClipboard(button: HTMLButtonElement, target: HTMLElement): Promise<void> {
  const text = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    report(button, true);
  } catch {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select();
    report(button, false);
  }
}

interface CopyCommandEvent extends Event {
  readonly command: string;
  readonly source: EventTarget | null;
}

function isCopyCommand(event: Event): event is CopyCommandEvent {
  if (!("command" in event) || typeof event.command !== "string" || !event.command.startsWith("--copy")) return false;
  return "source" in event;
}

/** Invoker Commands are not widely available yet, so older browsers copy from the click. */
export function useCopyCommands(): void {
  useEffect(() => {
    if (!("CommandEvent" in window)) return;
    const onCommand = (event: Event) => {
      if (!isCopyCommand(event)) return;
      const button = event.source;
      const target = event.target;
      if (!(button instanceof HTMLButtonElement) || !(target instanceof HTMLElement)) return;
      void writeClipboard(button, target);
    };
    document.addEventListener("command", onCommand, true);
    return () => document.removeEventListener("command", onCommand, true);
  }, []);
}

export function CopyLink({ value, label }: { value: string; label: string }) {
  const reactId = useId().replaceAll(":", "");
  const inputId = `copy-${reactId}`;
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="copy-row">
      <label className="visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <input id={inputId} ref={inputRef} readOnly value={value} spellCheck={false} autoComplete="off" />
      <span className="copy">
        <button
          type="button"
          className="secondary copy-button"
          {...{ command: "--copy", commandfor: inputId }}
          onClick={(event) => {
            if ("CommandEvent" in window) return;
            const target = inputRef.current;
            if (target) void writeClipboard(event.currentTarget, target);
          }}
        >
          複製
        </button>
        <span className="tip" role="status" />
      </span>
    </div>
  );
}
