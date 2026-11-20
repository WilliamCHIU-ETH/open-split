import { useEffect, useState } from "react";
import type { InvitePreview } from "@open-split/contracts";
import { ApiError, api } from "./api.ts";

export function Invite({ token }: { token: string }) {
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .previewInvite(token)
      .then((body) => {
        if (!cancelled) setPreview(body);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "這條邀請連結打不開。");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join() {
    setPending(true);
    setError(null);
    try {
      const result = await api.acceptInvite(token);
      window.history.pushState({}, "", `/groups/${result.groupId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "沒有加入。");
      setPending(false);
    }
  }

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        {preview ? `加入「${preview.groupName}」` : "邀請連結"}
      </h1>
      {!preview && !error ? <progress aria-label="正在讀取邀請" /> : null}
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <>
          <p>
            {preview.alreadyMember
              ? "你已經是這個群組的成員。"
              : `加入後會用你現在的名字，成為「${preview.groupName}」的新成員。幣別是 ${preview.currency}。`}
          </p>
          {preview.alreadyMember ? (
            <a className="button" href={`/groups/${preview.groupId}`}>
              打開帳本
            </a>
          ) : (
            <button type="button" disabled={pending} onClick={() => void join()}>
              {pending ? "加入中" : "加入群組"}
            </button>
          )}
        </>
      ) : null}
      <p className="mt-6">
        <a href="/">回到群組列表</a>
      </p>
    </>
  );
}