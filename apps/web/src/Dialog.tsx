import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";

export function Dialog({
  open,
  labelledBy,
  onClose,
  children,
}: {
  open: boolean;
  labelledBy: string;
  onClose: (returnValue: string) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || "closedBy" in HTMLDialogElement.prototype) return;
    let pressedOutside = false;
    const outside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    };
    const onDown = (event: PointerEvent) => {
      pressedOutside = outside(event);
    };
    const onUp = (event: PointerEvent) => {
      if (pressedOutside && outside(event)) dialog.close();
    };
    dialog.addEventListener("pointerdown", onDown);
    dialog.addEventListener("pointerup", onUp);
    return () => {
      dialog.removeEventListener("pointerdown", onDown);
      dialog.removeEventListener("pointerup", onUp);
    };
  }, []);

  function handleClose(event: SyntheticEvent<HTMLDialogElement>) {
    const dialog = event.currentTarget;
    const value = dialog.returnValue;
    dialog.returnValue = "";
    onClose(value);
  }

  return (
    <dialog ref={ref} aria-labelledby={labelledBy} {...{ closedby: "any" }} onClose={handleClose}>
      <div className="dialog-panel">{children}</div>
    </dialog>
  );
}
