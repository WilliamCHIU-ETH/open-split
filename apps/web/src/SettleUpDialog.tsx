import { useId, useRef, useState, type FormEvent } from "react";
import type { GroupDetail, SettlementView } from "@open-split/contracts";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { formatMoney } from "./format.ts";
import { readMinor } from "./preview.ts";

export type SettleUpAction =
  | { kind: "record"; fromMemberId: string; toMemberId: string; amount: string }
  | { kind: "void"; settlement: SettlementView }
  | { kind: "profile"; member: GroupDetail["members"][number] };

export function SettleUpDialog({
  action,
  detail,
  onClose,
  onChanged,
}: {
  action: SettleUpAction | null;
  detail: GroupDetail;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const titleId = useId();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const { id: groupId, defaultCurrency: currency } = detail.group;

  function close() {
    setError(null);
    onClose();
  }

  async function save(write: () => Promise<unknown>, message: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await write();
      onChanged(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有存成。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || inFlight.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (action.kind === "void") {
      void save(() => api.voidSettlement(groupId, action.settlement.id), "已作廢這筆結清。餘額已重算。");
      return;
    }
    if (action.kind === "profile") {
      const label = String(data.get("label") ?? "").trim();
      const details = String(data.get("details") ?? "").trim();
      if (!label || !details) {
        invalidField(form, label ? "details" : "label", label ? "請填收款資訊。" : "請填收款方式名稱。");
        return;
      }
      void save(() => api.savePaymentProfile(groupId, action.member.id, { label, details }), "已儲存收款方式。");
      return;
    }

    const fromMemberId = String(data.get("fromMemberId") ?? "");
    const toMemberId = String(data.get("toMemberId") ?? "");
    const amount = String(data.get("amount") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    if (fromMemberId === toMemberId) {
      invalidField(form, "toMemberId", "付款人與收款人必須是不同的成員。");
      return;
    }
    if (!readMinor(amount) || amount === "0") {
      invalidField(form, "amount", "金額要是大於 0 的整數，不能有小數點或前導零。");
      return;
    }
    void save(
      () => api.recordSettlement(groupId, { fromMemberId, toMemberId, amount, currency, ...(note ? { note } : {}) }),
      "已記錄這筆結清。",
    );
  }

  const profile = action?.kind === "profile" ? action.member.paymentProfile : null;
  const title = action?.kind === "profile" ? `${action.member.displayName} 的收款方式`
    : action?.kind === "void" ? "作廢這筆結清？" : "記錄結清";

  return (
    <Dialog open={action !== null} pending={pending} labelledBy={titleId} onClose={close}>
      {action ? (
        <form onSubmit={submit}>
          <div className="dialog-scroll">
            <h2 id={titleId}>{title}</h2>
            {action.kind === "record" ? (
              <>
                <div className="field mt-3">
                  <label htmlFor={`${titleId}-from`}>付款人</label>
                  <select
                    id={`${titleId}-from`}
                    name="fromMemberId"
                    defaultValue={action.fromMemberId}
                    required
                    onChange={(event) => {
                      const field = event.currentTarget.form?.elements.namedItem("toMemberId");
                      if (field instanceof HTMLSelectElement) field.setCustomValidity("");
                    }}
                  >
                    {detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${titleId}-to`}>收款人</label>
                  <select
                    id={`${titleId}-to`}
                    name="toMemberId"
                    defaultValue={action.toMemberId}
                    required
                    onChange={(event) => event.currentTarget.setCustomValidity("")}
                    onInvalid={(event) => {
                      if (event.currentTarget.validity.valueMissing) event.currentTarget.setCustomValidity("請選收款人。");
                    }}
                  >
                    <option value="" disabled>請選收款人</option>
                    {detail.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${titleId}-amount`}>金額（{currency}，最小貨幣單位）</label>
                  <input
                    id={`${titleId}-amount`}
                    name="amount"
                    defaultValue={action.amount}
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    onInput={(event) => event.currentTarget.setCustomValidity("")}
                    onInvalid={(event) => {
                      if (event.currentTarget.validity.valueMissing) event.currentTarget.setCustomValidity("請填金額。");
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${titleId}-note`}>備註（選填）</label>
                  <textarea id={`${titleId}-note`} name="note" maxLength={200} placeholder="轉帳末五碼 12345" />
                </div>
              </>
            ) : null}
            {action.kind === "profile" ? (
              <>
                <div className="field mt-3">
                  <label htmlFor={`${titleId}-label`}>名稱</label>
                  <input
                    id={`${titleId}-label`}
                    name="label"
                    defaultValue={profile?.label}
                    placeholder="銀行轉帳"
                    maxLength={40}
                    required
                    onInput={(event) => event.currentTarget.setCustomValidity("")}
                    onInvalid={(event) => event.currentTarget.setCustomValidity("請填收款方式名稱。")}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${titleId}-details`}>收款資訊</label>
                  <textarea
                    id={`${titleId}-details`}
                    name="details"
                    defaultValue={profile?.details}
                    maxLength={500}
                    required
                    onInput={(event) => event.currentTarget.setCustomValidity("")}
                    onInvalid={(event) => event.currentTarget.setCustomValidity("請填收款資訊。")}
                  />
                </div>
                {profile ? (
                  <button type="button" className="danger" disabled={pending} onClick={() => {
                    void save(() => api.clearPaymentProfile(groupId, action.member.id), "已清除收款方式。");
                  }}>
                    清除收款方式
                  </button>
                ) : null}
              </>
            ) : null}
            {action.kind === "void" ? (
              <p className="mt-3">
                {formatMoney(action.settlement.amount, action.settlement.currency)}。
                作廢後不再計入餘額，活動紀錄會留下。
              </p>
            ) : null}
            <p role="alert">{error}</p>
          </div>
          <div className="dialog-actions">
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- initial focus on the safe action in a native confirmation dialog */}
            <button type="button" className="secondary" disabled={pending} autoFocus={action.kind === "void"} onClick={close}>
              {action.kind === "void" ? "保留" : "取消"}
            </button>
            <button type="submit" className={action.kind === "void" ? "danger" : undefined} disabled={pending}>
              {pending ? "處理中" : action.kind === "void" ? "作廢" : "儲存"}
            </button>
          </div>
        </form>
      ) : <h2 id={titleId}>{title}</h2>}
    </Dialog>
  );
}

function invalidField(form: HTMLFormElement, name: string, message: string) {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) {
    field.setCustomValidity(message);
    field.reportValidity();
  }
}
