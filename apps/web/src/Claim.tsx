import { useEffect, useState } from "react";
import type { ClaimPreview } from "@open-split/contracts";
import { ApiError, api } from "./api.ts";

export function Claim({ token }: { token: string }) {
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .previewClaim(token)
      .then((body) => {
        if (!cancelled) setPreview(body);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "這條認領連結打不開。");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function claim() {
    setPending(true);
    setError(null);
    try {
      const result = await api.claim(token);
      window.history.pushState({}, "", `/groups/${result.groupId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "沒有認領。");
      setPending(false);
    }
  }

  const title =
    preview?.status === "yours"
      ? "這是你的位置"
      : preview?.status === "taken"
        ? "這個位置已經有人"
        : preview?.status === "already_member"
          ? "你已經在這個群組裡"
          : "認領你的位置";

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        {preview ? title : "認領"}
      </h1>
      {!preview && !error ? <progress aria-label="正在讀取認領連結" /> : null}
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <>
          <p>
            {preview.displayName} 在「{preview.groupName}」的帳。認領之後，過去的份額還是掛在同一個人，餘額不用重算。
          </p>
          {preview.status === "open" ? (
            <button type="button" disabled={pending} onClick={() => void claim()}>
              {pending ? "認領中" : `認領「${preview.displayName}」`}
            </button>
          ) : null}
          {preview.status === "yours" ? (
            <p>
              <a className="button" href={`/groups/${preview.groupId}`}>
                打開帳本
              </a>
            </p>
          ) : null}
          {preview.status === "already_member" ? (
            <p>一個人在群組裡只佔一個位置。請用原本的成員看帳，或請朋友用自己的帳號打開這條連結。</p>
          ) : null}
          {preview.status === "taken" ? <p>這條連結已經被用掉了。</p> : null}
        </>
      ) : null}
      <p className="mt-6">
        <a href="/">回到群組列表</a>
      </p>
    </>
  );
}
