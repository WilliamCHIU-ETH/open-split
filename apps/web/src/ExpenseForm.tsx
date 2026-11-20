import { useId, useState, type FormEvent } from "react";
import type { GroupDetail, SplitWire } from "@open-split/contracts";
import type { ExpenseDraft } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { formatMoney } from "./format.ts";
import {
  equalPercents,
  exactShareFor,
  parsePercent,
  previewSplit,
  type SplitMode,
} from "./preview.ts";

export interface ExpenseFormState {
  readonly expenseId: string | null;
  readonly amount: string;
  readonly payerId: string;
  readonly participantIds: readonly string[];
  readonly category: string;
  readonly note: string;
  readonly split: SplitWire;
}

const MODES: readonly { id: SplitMode; label: string }[] = [
  { id: "equal", label: "平均" },
  { id: "exact", label: "指定金額" },
  { id: "percentage", label: "百分比" },
  { id: "shares", label: "份數" },
];

export function ExpenseForm({
  form,
  detail,
  onClose,
  onSave,
}: {
  form: ExpenseFormState | null;
  detail: GroupDetail | null;
  onClose: () => void;
  onSave: (draft: ExpenseDraft, expenseId: string | null) => Promise<void>;
}) {
  const headingId = useId();
  return (
    <Dialog open={form !== null} labelledBy={headingId} onClose={onClose}>
      {form && detail ? (
        <ExpenseFields key={form.expenseId ?? "new"} form={form} detail={detail} headingId={headingId} onClose={onClose} onSave={onSave} />
      ) : (
        <h2 id={headingId}>記一筆</h2>
      )}
    </Dialog>
  );
}

function ExpenseFields({
  form,
  detail,
  headingId,
  onClose,
  onSave,
}: {
  form: ExpenseFormState;
  detail: GroupDetail;
  headingId: string;
  onClose: () => void;
  onSave: (draft: ExpenseDraft, expenseId: string | null) => Promise<void>;
}) {
  const prefix = useId().replaceAll(":", "");
  const editing = form.expenseId !== null;
  const [amount, setAmount] = useState(form.amount);
  const [payerId, setPayerId] = useState(form.payerId);
  const [selected, setSelected] = useState<string[]>([...form.participantIds]);
  const [mode, setMode] = useState<SplitMode>(form.split.type);
  const [exact, setExact] = useState<Record<string, string>>(() => exactFrom(form.split));
  const [percent, setPercent] = useState<Record<string, string>>(() => percentFrom(form.split));
  const [weights, setWeights] = useState<Record<string, string>>(() => weightsFrom(form.split));
  const [category, setCategory] = useState(form.category);
  const [note, setNote] = useState(form.note);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = previewSplit({ amountText: amount, mode, participantIds: selected, exact, percent, weights });
  const currency = detail.group.defaultCurrency;
  const firstSelected = detail.members.find((member) => selected.includes(member.id));

  function chooseMode(next: SplitMode) {
    setMode(next);
    if (next === "shares") {
      setWeights((current) => fillOnes(selected, current));
    }
  }

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = on ? (current.includes(id) ? current : [...current, id]) : current.filter((item) => item !== id);
      if (on && mode === "shares") setWeights((weightsNow) => fillOnes(next, weightsNow));
      return next;
    });
  }

  function fillPercents() {
    if (selected.length === 0) return;
    setPercent((current) => ({ ...current, ...equalPercents(selected) }));
  }

  function fillExact() {
    if (!firstSelected) return;
    const value = exactShareFor(amount, selected, exact, firstSelected.id);
    if (value === null) return;
    setExact((current) => ({ ...current, [firstSelected.id]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const boxes = [...formElement.querySelectorAll<HTMLInputElement>('input[name="participant"]')];
    const firstBox = boxes[0];
    if (selected.length === 0) {
      firstBox?.setCustomValidity("至少要有一個人分攤。");
      firstBox?.reportValidity();
      return;
    }
    for (const box of boxes) box.setCustomValidity("");
    if (!preview.ready) {
      const field =
        formElement.querySelector<HTMLInputElement>(`input[name="${mode === "equal" ? "amount" : mode}"]`) ??
        formElement.querySelector<HTMLInputElement>('input[name="amount"]');
      field?.setCustomValidity(preview.message);
      field?.reportValidity();
      return;
    }
    const draft: ExpenseDraft = {
      groupId: detail.group.id,
      payerId,
      amount: amount.trim(),
      currency,
      participantIds: selected,
      split: wireSplit(mode, selected, exact, percent, weights),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setPending(true);
    setError(null);
    try {
      await onSave(draft, form.expenseId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有存成。");
    } finally {
      setPending(false);
    }
  }

  return (
    <form aria-labelledby={headingId} onSubmit={(event) => void onSubmit(event)}>
      <div className="dialog-scroll">
      <h2 id={headingId}>{editing ? "修改支出" : "記一筆"}</h2>
      <p id={`${prefix}-hint`} className="text-sm text-muted">
        幣別是 {currency}。金額填整數，預覽記帳後以帳本為準。
      </p>
      <div className="field">
        <label htmlFor={`${prefix}-amount`}>
          金額 <span aria-hidden="true">*</span>
        </label>
        <input
          id={`${prefix}-amount`}
          name="amount"
          inputMode="numeric"
          autoComplete="off"
          required
          pattern="^(0|[1-9][0-9]*)$"
          value={amount}
          aria-describedby={`${prefix}-hint`}
          enterKeyHint="next"
          onChange={(event) => {
            event.currentTarget.setCustomValidity("");
            setAmount(event.currentTarget.value);
          }}
          onInvalid={(event) => {
            const input = event.currentTarget;
            input.setCustomValidity(input.validity.valueMissing ? "請填金額。" : "金額要是整數，不能有小數點或前導零。");
          }}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-payer`}>誰先付</label>
        <select id={`${prefix}-payer`} name="payer" value={payerId} required onChange={(event) => setPayerId(event.currentTarget.value)}>
          {detail.members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
              {member.virtual ? "（尚未註冊）" : ""}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="field">
        <legend>怎麼分</legend>
        <div className="method-choices">
          {MODES.map((item) => (
            <label key={item.id} className="method" htmlFor={`${prefix}-mode-${item.id}`}>
              <input
                id={`${prefix}-mode-${item.id}`}
                className="choice-input"
                type="radio"
                name="mode"
                value={item.id}
                checked={mode === item.id}
                onChange={() => chooseMode(item.id)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>
          誰要分攤 <span aria-hidden="true">*</span>
        </legend>
        <p className="text-sm text-muted">沒勾的人這筆不用付。</p>
        {detail.members.map((member) => (
          <label key={member.id} className="choice" htmlFor={`${prefix}-part-${member.id}`}>
            <input
              id={`${prefix}-part-${member.id}`}
              className="choice-input"
              type="checkbox"
              name="participant"
              value={member.id}
              checked={selected.includes(member.id)}
              onChange={(event) => {
                event.currentTarget.setCustomValidity("");
                toggle(member.id, event.currentTarget.checked);
              }}
            />
            <span>
              {member.displayName}
              {member.virtual ? "，尚未註冊" : ""}
            </span>
          </label>
        ))}
      </fieldset>
      {mode === "equal" ? null : (
        <fieldset className="field">
          <legend>{mode === "exact" ? "每個人多少" : mode === "percentage" ? "每個人的百分比" : "每個人幾份"}</legend>
          {detail.members
            .filter((member) => selected.includes(member.id))
            .map((member) => (
              <div key={member.id} className="person-row">
                <label htmlFor={`${prefix}-${mode}-${member.id}`}>{member.displayName}</label>
                {mode === "exact" ? (
                  <input
                    id={`${prefix}-exact-${member.id}`}
                    name="exact"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    pattern="^(0|[1-9][0-9]*)$"
                    value={exact[member.id] ?? ""}
                    enterKeyHint="next"
                    onChange={(event) => {
                      event.currentTarget.setCustomValidity("");
                      setExact((current) => ({ ...current, [member.id]: event.currentTarget.value }));
                    }}
                  />
                ) : null}
                {mode === "percentage" ? (
                  <input
                    id={`${prefix}-percentage-${member.id}`}
                    name="percentage"
                    inputMode="decimal"
                    autoComplete="off"
                    required
                    value={percent[member.id] ?? ""}
                    aria-describedby={`${prefix}-percent-help`}
                    enterKeyHint="next"
                    onChange={(event) => {
                      event.currentTarget.setCustomValidity("");
                      setPercent((current) => ({ ...current, [member.id]: event.currentTarget.value }));
                    }}
                    onBlur={(event) => {
                      const points = parsePercent(event.currentTarget.value);
                      if (points === null && event.currentTarget.value.trim().length > 0) {
                        event.currentTarget.setCustomValidity("百分比要大於 0，最多小數兩位。");
                      }
                    }}
                  />
                ) : null}
                {mode === "shares" ? (
                  <input
                    id={`${prefix}-shares-${member.id}`}
                    name="shares"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    pattern="^[1-9][0-9]*$"
                    value={weights[member.id] ?? ""}
                    enterKeyHint="next"
                    onChange={(event) => {
                      event.currentTarget.setCustomValidity("");
                      setWeights((current) => ({ ...current, [member.id]: event.currentTarget.value }));
                    }}
                    onInvalid={(event) => event.currentTarget.setCustomValidity("份數要是正整數。")}
                  />
                ) : null}
              </div>
            ))}
          {mode === "percentage" ? (
            <p id={`${prefix}-percent-help`} className="text-sm text-muted">
              填 50 代表 50%。合計要到 100。
            </p>
          ) : null}
          {mode === "exact" && firstSelected ? (
            <button type="button" className="secondary" onClick={fillExact}>
              把剩下的算給{firstSelected.displayName}
            </button>
          ) : null}
          {mode === "percentage" ? (
            <button type="button" className="secondary" onClick={fillPercents}>
              平均填百分比
            </button>
          ) : null}
          {mode === "shares" ? (
            <button type="button" className="secondary" onClick={() => setWeights(fillOnes(selected, {}))}>
              每人 1 份
            </button>
          ) : null}
        </fieldset>
      )}
      <div className={`preview ${preview.ready ? "is-ready" : ""}`}>
        <p>{preview.message}</p>
        {preview.lines.length > 0 ? (
          <ul>
            {detail.members
              .filter((member) => selected.includes(member.id))
              .map((member) => {
                const line = preview.lines.find((item) => item.participantId === member.id);
                if (!line) return null;
                return (
                  <li key={member.id}>
                    <span>{member.displayName}</span>
                    <span className="money">{formatMoney(line.amount, currency)}</span>
                  </li>
                );
              })}
          </ul>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-category`}>分類</label>
        <input
          id={`${prefix}-category`}
          name="category"
          maxLength={40}
          value={category}
          enterKeyHint="next"
          onChange={(event) => setCategory(event.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-note`}>備註</label>
        <textarea id={`${prefix}-note`} name="note" maxLength={500} value={note} onChange={(event) => setNote(event.currentTarget.value)} />
      </div>
      {error ? (
        <p role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>
          取消
        </button>
        <button type="submit" disabled={pending}>
          {pending ? "儲存中" : editing ? "儲存修改" : "記帳"}
        </button>
      </div>
    </form>
  );
}

function wireSplit(
  mode: SplitMode,
  ids: readonly string[],
  exact: Readonly<Record<string, string>>,
  percent: Readonly<Record<string, string>>,
  weights: Readonly<Record<string, string>>,
): SplitWire {
  if (mode === "equal") return { type: "equal" };
  if (mode === "exact") {
    const amounts: Record<string, string> = {};
    for (const id of ids) amounts[id] = (exact[id] ?? "").trim();
    return { type: "exact", amounts };
  }
  if (mode === "percentage") {
    const basisPoints: Record<string, number> = {};
    for (const id of ids) {
      const points = parsePercent(percent[id] ?? "");
      if (points !== null) basisPoints[id] = points;
    }
    return { type: "percentage", basisPoints };
  }
  const parsed: Record<string, number> = {};
  for (const id of ids) parsed[id] = Number(weights[id] ?? "1");
  return { type: "shares", weights: parsed };
}

function exactFrom(split: SplitWire): Record<string, string> {
  if (split.type !== "exact") return {};
  return { ...split.amounts };
}

function percentFrom(split: SplitWire): Record<string, string> {
  if (split.type !== "percentage") return {};
  const record: Record<string, string> = {};
  for (const [id, points] of Object.entries(split.basisPoints)) {
    const whole = Math.trunc(points / 100);
    const frac = points % 100;
    record[id] = frac === 0 ? String(whole) : `${String(whole)}.${String(frac).padStart(2, "0")}`;
  }
  return record;
}

function weightsFrom(split: SplitWire): Record<string, string> {
  if (split.type !== "shares") return {};
  const record: Record<string, string> = {};
  for (const [id, weight] of Object.entries(split.weights)) record[id] = String(weight);
  return record;
}

function fillOnes(ids: readonly string[], current: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...current };
  for (const id of ids) {
    if (!next[id]) next[id] = "1";
  }
  return next;
}
