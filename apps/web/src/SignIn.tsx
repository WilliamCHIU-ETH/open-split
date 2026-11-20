import { useState, type FormEvent } from "react";
import type { CurrentSession } from "@open-split/contracts";
import { ApiError, api } from "./api.ts";

export function SignIn({
  devEnabled,
  onSignedIn,
}: {
  devEnabled: boolean;
  onSignedIn: (session: CurrentSession) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "");
    const provider = data.get("provider") === "google" ? "google" : "line";
    setPending(true);
    setError(null);
    try {
      const session = await api.signIn(name, provider);
      onSignedIn(session);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "登入沒有完成。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        登入帳本
      </h1>
      {devEnabled ? (
        <form aria-labelledby="page-title" onSubmit={(event) => void onSubmit(event)} noValidate={false}>
          <p id="sign-in-help" className="text-muted">
            名稱會交給 Worker。只有本機開發環境會建立工作階段。LINE 是主要登入，Google 是次要登入；正式的授權碼交換還沒有接上。
          </p>
          <div className="field">
            <label htmlFor="sign-in-name">
              名稱 <span aria-hidden="true">*</span>
            </label>
            <input
              id="sign-in-name"
              name="name"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              enterKeyHint="done"
              aria-describedby="sign-in-help"
              onInput={(event) => event.currentTarget.setCustomValidity("")}
              onInvalid={(event) => event.currentTarget.setCustomValidity("請填名稱。名稱需以小寫英文開頭。")}
            />
          </div>
          <fieldset className="field">
            <legend>
              登入方式 <span aria-hidden="true">*</span>
            </legend>
            <label className="choice" htmlFor="provider-line">
              <input id="provider-line" type="radio" name="provider" value="line" defaultChecked required />
              LINE
            </label>
            <label className="choice" htmlFor="provider-google">
              <input id="provider-google" type="radio" name="provider" value="google" required />
              Google
            </label>
          </fieldset>
          {error ? (
            <p role="alert" tabIndex={-1}>
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={pending}>
            {pending ? "登入中" : "登入"}
          </button>
        </form>
      ) : (
        <p>這個環境沒有打開本機登入，正式的 LINE／Google 登入也還沒有接上。</p>
      )}
    </>
  );
}
