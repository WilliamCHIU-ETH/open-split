import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { AttachmentSummary, FxRateWire, GroupDetail, SplitWire } from "@open-split/contracts";
import { ATTACHMENT_MAX_PER_EXPENSE } from "@open-split/contracts/client";
import { SUPPORTED_CURRENCIES, currencyExponent, formatMinor, toMinorUnits } from "@open-split/core";
import { api, type ExpenseDraft } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { formatBytes, formatDecimalInput, formatMoney } from "./format.ts";
import {
  decimalHintForCurrency,
  decimalPatternForCurrency,
  equalPercents,
  exactShareFor,
  parsePercent,
  previewSplit,
  readMajorAsMinor,
  readRateRatio,
  type SplitMode,
} from "./preview.ts";

export interface ExpenseFormState {
  readonly expenseId: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly fxRateText: string;
  readonly payerId: string;
  readonly participantIds: readonly string[];
  readonly category: string;
  readonly note: string;
  readonly split: SplitWire;
  readonly attachments: readonly AttachmentSummary[];
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
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editing = form.expenseId !== null;
  const defaultCurrency = detail.group.defaultCurrency;
  const [amount, setAmount] = useState(form.amount);
  const [currency, setCurrency] = useState(form.currency);
  const [fxRateText, setFxRateText] = useState(form.fxRateText);
  const [payerId, setPayerId] = useState(form.payerId);
  const [selected, setSelected] = useState<string[]>([...form.participantIds]);
  const [mode, setMode] = useState<SplitMode>(form.split.type);
  const [exact, setExact] = useState<Record<string, string>>(() => exactFrom(form.split, form.currency));
  const [percent, setPercent] = useState<Record<string, string>>(() => percentFrom(form.split));
  const [weights, setWeights] = useState<Record<string, string>>(() => weightsFrom(form.split));
  const [category, setCategory] = useState(form.category);
  const [note, setNote] = useState(form.note);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([...form.attachments]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isForeign = currency !== defaultCurrency;
  const exp = currencyExponent(currency);
  const preview = previewSplit({
    amountText: amount,
    currency,
    defaultCurrency,
    fxRateText,
    mode,
    participantIds: selected,
    exact,
    percent,
    weights,
  });
  const firstSelected = detail.members.find((member) => selected.includes(member.id));

  useEffect(() => {
    clearCrossFieldValidity(formRef.current);
  }, [amount, currency, fxRateText, mode, selected, exact, percent, weights]);

  function chooseMode(next: SplitMode) {
    clearCrossFieldValidity(formRef.current);
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
    clearCrossFieldValidity(formRef.current);
    setPercent((current) => ({ ...current, ...equalPercents(selected) }));
  }

  function fillExact() {
    if (!firstSelected) return;
    const value = exactShareFor(amount, currency, selected, exact, firstSelected.id);
    if (value === null) return;
    clearCrossFieldValidity(formRef.current);
    setExact((current) => ({ ...current, [firstSelected.id]: value }));
  }

  async function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const fileList = event.currentTarget.files;
    if (!fileList || fileList.length === 0) return;
    const files = [...fileList];
    event.currentTarget.value = "";
    if (attachments.length + files.length > ATTACHMENT_MAX_PER_EXPENSE) {
      setUploadError(`每筆支出最多只能附加 ${String(ATTACHMENT_MAX_PER_EXPENSE)} 份收據。`);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of files) {
        const uploaded = await api.uploadReceiptFile(detail.group.id, file);
        setAttachments((current) => [...current, uploaded]);
      }
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "收據上傳失敗。");
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(attachment: AttachmentSummary) {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.expenseId === null) {
      void api.deleteAttachment(detail.group.id, attachment.id).catch(() => {});
    }
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

    const parsedAmount = readMajorAsMinor(amount, currency);
    if (parsedAmount === null || toMinorUnits(parsedAmount) <= 0n) {
      const amountField = formElement.querySelector<HTMLInputElement>('input[name="amount"]');
      amountField?.setCustomValidity(`金額要大於 0。${decimalHintForCurrency(currency)}`);
      amountField?.reportValidity();
      return;
    }

    let fxRate: FxRateWire | undefined;
    if (isForeign) {
      const parsedRate = readRateRatio(fxRateText);
      if (!parsedRate) {
        const rateField = formElement.querySelector<HTMLInputElement>('input[name="fxRate"]');
        rateField?.setCustomValidity("請填正數匯率，例如 0.21、31.5 或 63/2。");
        rateField?.reportValidity();
        return;
      }
      fxRate = parsedRate;
    }

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
      amount: formatMinor(parsedAmount),
      currency,
      ...(fxRate ? { fxRate } : {}),
      participantIds: selected,
      split: wireSplit(mode, currency, selected, exact, percent, weights),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      attachmentIds: attachments.map((item) => item.id),
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
    <form ref={formRef} aria-labelledby={headingId} onSubmit={(event) => void onSubmit(event)}>
      <div className="dialog-scroll">
        <h2 id={headingId}>{editing ? "修改支出" : "記一筆"}</h2>
        <div className="field mt-3">
          <label htmlFor={`${prefix}-currency`}>幣別</label>
          <select
            id={`${prefix}-currency`}
            name="currency"
            value={currency}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setCurrency(next);
              if (next === defaultCurrency) setFxRateText("");
              clearCrossFieldValidity(event.currentTarget.form);
            }}
          >
            {SUPPORTED_CURRENCIES.map((code) => (
              <option key={code} value={code}>
                {code}
                {code === defaultCurrency ? "（群組預設）" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${prefix}-amount`}>
            金額（{currency}）<span aria-hidden="true">*</span>
          </label>
          <p id={`${prefix}-hint`} className="text-sm text-muted">
            {decimalHintForCurrency(currency)} 預覽記帳後以帳本為準。
          </p>
          <input
            id={`${prefix}-amount`}
            name="amount"
            inputMode={exp === 0 ? "numeric" : "decimal"}
            autoComplete="off"
            required
            pattern={decimalPatternForCurrency(currency)}
            value={amount}
            aria-describedby={`${prefix}-hint`}
            enterKeyHint="next"
            onChange={(event) => {
              event.currentTarget.setCustomValidity("");
              clearCrossFieldValidity(event.currentTarget.form);
              setAmount(event.currentTarget.value);
            }}
            onInvalid={(event) => {
              const input = event.currentTarget;
              input.setCustomValidity(input.validity.valueMissing ? "請填金額。" : decimalHintForCurrency(currency));
            }}
          />
        </div>
        {isForeign ? (
          <div className="field">
            <label htmlFor={`${prefix}-fxrate`}>
              匯率（1 {currency} = 幾 {defaultCurrency}）<span aria-hidden="true">*</span>
            </label>
            <p id={`${prefix}-fxrate-hint`} className="text-sm text-muted">
              可填小數（例如 0.21 或 31.5）或分數（例如 63/2）。
            </p>
            <input
              id={`${prefix}-fxrate`}
              name="fxRate"
              inputMode="decimal"
              autoComplete="off"
              required
              value={fxRateText}
              aria-describedby={`${prefix}-fxrate-hint`}
              enterKeyHint="next"
              onChange={(event) => {
                event.currentTarget.setCustomValidity("");
                setFxRateText(event.currentTarget.value);
              }}
              onBlur={(event) => {
                const value = event.currentTarget.value.trim();
                if (value.length > 0 && !readRateRatio(value)) {
                  event.currentTarget.setCustomValidity("匯率要是正小數或正整數分數，例如 31.5 或 63/2。");
                }
              }}
            />
          </div>
        ) : null}
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
                  clearCrossFieldValidity(event.currentTarget.form);
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
            <legend>{mode === "exact" ? `每個人多少（${currency}）` : mode === "percentage" ? "每個人的百分比" : "每個人幾份"}</legend>
            {detail.members
              .filter((member) => selected.includes(member.id))
              .map((member) => (
                <div key={member.id} className="person-row">
                  <label htmlFor={`${prefix}-${mode}-${member.id}`}>{member.displayName}</label>
                  {mode === "exact" ? (
                    <input
                      id={`${prefix}-exact-${member.id}`}
                      name="exact"
                      inputMode={exp === 0 ? "numeric" : "decimal"}
                      autoComplete="off"
                      required
                      pattern={decimalPatternForCurrency(currency)}
                      value={exact[member.id] ?? ""}
                      enterKeyHint="next"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        event.currentTarget.setCustomValidity("");
                        clearCrossFieldValidity(event.currentTarget.form);
                        setExact((current) => ({ ...current, [member.id]: value }));
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
                        const value = event.currentTarget.value;
                        event.currentTarget.setCustomValidity("");
                        clearCrossFieldValidity(event.currentTarget.form);
                        setPercent((current) => ({ ...current, [member.id]: value }));
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
                        const value = event.currentTarget.value;
                        event.currentTarget.setCustomValidity("");
                        clearCrossFieldValidity(event.currentTarget.form);
                        setWeights((current) => ({ ...current, [member.id]: value }));
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
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  clearCrossFieldValidity(formRef.current);
                  setWeights(fillOnes(selected, {}));
                }}
              >
                每人 1 份
              </button>
            ) : null}
          </fieldset>
        )}
        <div className={`preview ${preview.ready ? "is-ready" : ""}`}>
          <p>{preview.message}</p>
          {preview.ready && isForeign && preview.convertedTotal ? (
            <p className="text-sm font-semibold mt-1">
              折合 <span className="money">{formatMoney(preview.convertedTotal, defaultCurrency)}</span>
            </p>
          ) : null}
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
                      <span className="money">
                        {formatMoney(line.amount, defaultCurrency)}
                        {isForeign ? `（${formatMoney(line.originalAmount, currency)}）` : ""}
                      </span>
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
        <div className="field">
          <label htmlFor={`${prefix}-receipts`}>收據附檔（選填，最多 {String(ATTACHMENT_MAX_PER_EXPENSE)} 份）</label>
          <p id={`${prefix}-receipts-hint`} className="text-sm text-muted">
            支援 JPG、PNG、WEBP 或 PDF（單檔上限 10 MB，僅作原檔保存）。
          </p>
          <input
            ref={fileInputRef}
            id={`${prefix}-receipts`}
            name="receipts"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            disabled={uploading || attachments.length >= ATTACHMENT_MAX_PER_EXPENSE}
            aria-describedby={`${prefix}-receipts-hint`}
            onChange={(event) => void onFilesSelected(event)}
          />
          {uploading ? <progress aria-label="正在上傳收據" /> : null}
          {uploadError ? <p role="alert">{uploadError}</p> : null}
          {attachments.length > 0 ? (
            <ul className="attachment-list">
              {attachments.map((att) => (
                <li key={att.id} className="attachment-item">
                  <a href={att.downloadPath} target="_blank" rel="noopener noreferrer">
                    {att.filename}
                  </a>
                  <span className="text-sm text-muted">{formatBytes(att.byteSize)}</span>
                  <button
                    type="button"
                    className="secondary attachment-remove"
                    onClick={() => removeAttachment(att)}
                  >
                    移除<span className="visually-hidden"> {att.filename}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
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
        <button type="submit" disabled={pending || uploading}>
          {pending ? "儲存中" : uploading ? "收據上傳中" : editing ? "儲存修改" : "記帳"}
        </button>
      </div>
    </form>
  );
}

function clearCrossFieldValidity(formElement: HTMLFormElement | null) {
  formElement
    ?.querySelectorAll<HTMLInputElement>(
      'input[name="amount"], input[name="fxRate"], input[name="participant"], input[name="exact"], input[name="percentage"], input[name="shares"]',
    )
    .forEach((field) => {
      if (field.validity.customError) field.setCustomValidity("");
    });
}

function wireSplit(
  mode: SplitMode,
  currency: string,
  ids: readonly string[],
  exact: Readonly<Record<string, string>>,
  percent: Readonly<Record<string, string>>,
  weights: Readonly<Record<string, string>>,
): SplitWire {
  if (mode === "equal") return { type: "equal" };
  if (mode === "exact") {
    const amounts: Record<string, string> = {};
    for (const id of ids) {
      const minorValue = readMajorAsMinor(exact[id] ?? "", currency);
      amounts[id] = minorValue !== null ? formatMinor(minorValue) : "0";
    }
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

function exactFrom(split: SplitWire, currency: string): Record<string, string> {
  if (split.type !== "exact") return {};
  const record: Record<string, string> = {};
  for (const [id, minorText] of Object.entries(split.amounts)) {
    record[id] = formatDecimalInput(minorText, currency);
  }
  return record;
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
