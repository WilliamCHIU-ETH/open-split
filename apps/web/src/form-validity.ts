/** Keep aria-invalid aligned with :user-invalid. Native validity does not do this. */
export function installFormValidity(): () => void {
  const flagged = new WeakSet<Element>();

  const sync = (node: EventTarget | null) => {
    if (!(node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)) {
      return;
    }
    const invalid = node.matches(":user-invalid");
    if (invalid) {
      node.setAttribute("aria-invalid", "true");
      flagged.add(node);
      return;
    }
    if (flagged.has(node) || node.getAttribute("aria-invalid") !== "true") {
      node.setAttribute("aria-invalid", "false");
      flagged.delete(node);
    }
  };

  const onBlur = (event: FocusEvent) => sync(event.target);
  const onInput = (event: Event) => sync(event.target);
  const onChange = (event: Event) => sync(event.target);
  const onInvalid = (event: Event) => sync(event.target);
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Element && !event.target.hasAttribute("aria-invalid")) sync(event.target);
  };

  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("blur", onBlur, true);
  document.addEventListener("input", onInput);
  document.addEventListener("change", onChange);
  document.addEventListener("invalid", onInvalid, true);
  return () => {
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("blur", onBlur, true);
    document.removeEventListener("input", onInput);
    document.removeEventListener("change", onChange);
    document.removeEventListener("invalid", onInvalid, true);
  };
}
