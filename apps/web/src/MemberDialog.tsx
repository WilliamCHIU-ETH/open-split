import { useId, useRef, useState, type FormEvent } from "react";
import type { DevUser, GroupDetail } from "@open-split/contracts";
import { api } from "./api.ts";
import { CopyLink } from "./copy-link.tsx";
import { Dialog } from "./Dialog.tsx";

type Kind = "virtual" | "invite" | "account";

export function MemberDialog({
  open,
  groupId,
  members,
  directory,
  onClose,
  onChanged,
}: {
  open: boolean;
  groupId: string;
  members: GroupDetail["members"];
  directory: DevUser[] | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const headingId = useId();
  const created = useRef(false);
  return (
    <Dialog
      open={open}
      labelledBy={headingId}
      onClose={() => {
        if (created.current) {
          created.current = false;
          onChanged("成員已更新。");
          return;
        }
        onClose();
      }}
    >
      {open ? (
        <MemberFields
          key={`${groupId}-${String(open)}`}
          groupId={groupId}
          members={members}
          directory={directory}
          headingId={headingId}
          onClose={onClose}
          onChanged={onChanged}
          onLink={() => {
            created.current = true;
          }}
          onFinish={(message) => {
            created.current = false;
            onChanged(message);
          }}
        />
      ) : (
        <h2 id={headingId}>加人</h2>
      )}
    </Dialog>
  );
}

function MemberFields({
  groupId,
  members,
  directory,
  headingId,
  onClose,
  onChanged,
  onLink,
  onFinish,
}: {
  groupId: string;
  members: GroupDetail["members"];
  directory: DevUser[] | null;
  headingId: string;
  onClose: () => void;
  onChanged: (message: string) => void;
  onLink: () => void;
  onFinish: (message: string) => void;
}) {
  const prefix = useId().replaceAll(":", "");
  const [kind, setKind] = useState<Kind>("virtual");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ title: string; body: string; url: string; label: string } | null>(null);
  const taken = new Set(members.map((member) => member.userId).filter((id): id is string => id !== null));
  const available = (directory ?? []).filter((user) => !taken.has(user.userId));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (kind === "invite") {
        const invite = await api.createInvite(groupId);
        setLink({
          title: "把邀請連結傳給朋友",
          body: "對方登入後會以自己的帳號加入。這不會取代已經記在帳上的虛擬成員。",
          url: new URL(invite.invitePath, window.location.origin).href,
          label: "邀請連結",
        });
        onLink();
        return;
      }
      if (kind === "virtual") {
        const name = String(data.get("displayName") ?? "").trim();
        const member = await api.addMember(groupId, { displayName: name, virtual: true });
        const path = member.claim?.claimPath;
        if (!path) throw new Error("沒有產生認領連結。");
        onLink();
        setLink({
          title: `把認領連結給${member.displayName}`,
          body: "他登入後認領的是同一個位置。之前記的帳不會改掛到別人身上。",
          url: new URL(path, window.location.origin).href,
          label: "認領連結",
        });
        return;
      }
      const userId = String(data.get("userId") ?? "");
      const user = available.find((item) => item.userId === userId);
      await api.addMember(groupId, { displayName: user?.displayName ?? "成員", virtual: false, userId });
      onChanged("已加入成員。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有完成。");
    } finally {
      setPending(false);
    }
  }

  if (link) {
    return (
      <div className="dialog-body">
        <h2 id={headingId}>{link.title}</h2>
        <p>{link.body}</p>
        <CopyLink value={link.url} label={link.label} />
        <div className="dialog-actions">
          <button type="button" onClick={() => onFinish(kind === "virtual" ? "已加上還沒註冊的朋友。" : "已建立邀請連結。")}>
            完成
          </button>
        </div>
      </div>
    );
  }

  return (
    <form aria-labelledby={headingId} onSubmit={(event) => void onSubmit(event)}>
      <h2 id={headingId}>加人</h2>
      <fieldset className="field">
        <legend>這個人現在是什麼情況</legend>
        <label className="choice" htmlFor={`${prefix}-virtual`}>
          <input
            id={`${prefix}-virtual`}
            className="choice-input"
            type="radio"
            name="kind"
            value="virtual"
            checked={kind === "virtual"}
            onChange={() => setKind("virtual")}
          />
          <span>還沒註冊，先記在帳上</span>
        </label>
        <label className="choice" htmlFor={`${prefix}-invite`}>
          <input
            id={`${prefix}-invite`}
            className="choice-input"
            type="radio"
            name="kind"
            value="invite"
            checked={kind === "invite"}
            onChange={() => setKind("invite")}
          />
          <span>傳邀請連結，讓他自己加入</span>
        </label>
        <label className="choice" htmlFor={`${prefix}-account`}>
          <input
            id={`${prefix}-account`}
            className="choice-input"
            type="radio"
            name="kind"
            value="account"
            checked={kind === "account"}
            onChange={() => setKind("account")}
          />
          <span>已經在這台機器登入</span>
        </label>
      </fieldset>
      {kind === "virtual" ? (
        <div className="field">
          <label htmlFor={`${prefix}-name`}>
            怎麼稱呼 <span aria-hidden="true">*</span>
          </label>
          <input id={`${prefix}-name`} name="displayName" required maxLength={80} autoComplete="name" enterKeyHint="done" />
        </div>
      ) : null}
      {kind === "invite" ? <p className="text-sm text-muted">連結給還沒在群組裡的人。他會成為新的成員。</p> : null}
      {kind === "account" ? (
        <div className="field">
          <label htmlFor={`${prefix}-user`}>
            選擇的人 <span aria-hidden="true">*</span>
          </label>
          {available.length === 0 ? <p>還沒有其他人登入過。可以改用邀請連結，或先讓對方登入一次。</p> : null}
          <select id={`${prefix}-user`} name="userId" required={available.length > 0} disabled={available.length === 0}>
            {available.map((user) => (
              <option key={user.userId} value={user.userId}>
                {user.displayName}（{user.provider === "line" ? "LINE" : "Google"}）
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {error ? (
        <p role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={onClose}>
          取消
        </button>
        <button type="submit" disabled={pending || (kind === "account" && available.length === 0)}>
          {pending ? "處理中" : kind === "invite" ? "建立連結" : kind === "virtual" ? "先記上" : "加入"}
        </button>
      </div>
    </form>
  );
}
