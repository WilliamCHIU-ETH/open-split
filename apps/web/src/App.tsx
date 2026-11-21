import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api.ts";
import type { CurrentSession } from "@open-split/contracts";
import { Claim } from "./Claim.tsx";
import { useCopyCommands } from "./copy-link.tsx";
import { installFormValidity } from "./form-validity.ts";
import { Home } from "./Home.tsx";
import { Invite } from "./Invite.tsx";
import { Ledger } from "./Ledger.tsx";
import { parseRoute, readBrowserLocation, routeTitle, shouldInterceptNavigation } from "./router.ts";
import { SignIn } from "./SignIn.tsx";

export function App() {
  const [location, setLocation] = useState(readBrowserLocation);
  const [ready, setReady] = useState(false);
  const [devEnabled, setDevEnabled] = useState(false);
  const [session, setSession] = useState<CurrentSession | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  useCopyCommands();

  useEffect(() => installFormValidity(), []);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (
        !shouldInterceptNavigation({
          href,
          resolvedHref: anchor.href,
          origin: window.location.origin,
          target: anchor.getAttribute("target"),
          hasDownload: anchor.hasAttribute("download"),
        })
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.origin);
      event.preventDefault();
      window.history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
      setLocation({ pathname: url.pathname, search: url.search });
    }
    function onPop() {
      setLocation(readBrowserLocation());
    }
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await api.devEnabled();
        if (!cancelled) setDevEnabled(true);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          if (!cancelled) setDevEnabled(false);
        } else if (!cancelled) {
          setBootError(error instanceof Error ? error.message : "無法連上帳本。");
        }
      }
      try {
        const current = await api.session();
        if (!cancelled) setSession(current);
      } catch (error) {
        if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 0)) {
          if (!cancelled) setBootError(error instanceof Error ? error.message : "無法讀取登入狀態。");
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const route = parseRoute(location.pathname);
  const title = routeTitle(route);
  useEffect(() => {
    document.title = `${title} · open-split`;
  }, [title]);

  const onUnauthorized = useCallback(() => setSession(null), []);

  async function signOut() {
    await api.signOut();
    setSession(null);
    window.history.pushState({}, "", "/");
    setLocation({ pathname: "/", search: "" });
  }

  return (
    <>
      <a className="skip-link" href="#page-title">
        跳到主要內容
      </a>
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 py-3">
          <a href="/" className="font-serif text-lg font-semibold text-ink no-underline">
            open-split
          </a>
          {session ? (
            <div className="flex items-center gap-3">
              <p className="text-sm text-muted">
                {session.displayName}
                <span className="visually-hidden">，已用 {session.provider === "line" ? "LINE" : "Google"} 登入</span>
              </p>
              <button type="button" className="secondary" onClick={() => void signOut()}>
                登出
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <main className="sheet">
        {!ready ? (
          <>
            <h1 id="page-title" tabIndex={-1}>
              帳本
            </h1>
            <progress aria-label="正在讀取帳本" />
          </>
        ) : bootError ? (
          <>
            <h1 id="page-title" tabIndex={-1}>
              帳本連不上
            </h1>
            <p role="alert">{bootError}</p>
          </>
        ) : !session ? (
          <SignIn
            devEnabled={devEnabled}
            onSignedIn={setSession}
            hint={route.name === "claim" ? "登入後會回到認領。" : route.name === "invite" ? "登入後會回到邀請。" : null}
          />
        ) : route.name === "invite" ? (
          <Invite token={route.token} />
        ) : route.name === "claim" ? (
          <Claim token={route.token} />
        ) : route.name === "group" ? (
          <Ledger groupId={route.id} session={session} onUnauthorized={onUnauthorized} />
        ) : (
          <Home session={session} />
        )}
      </main>
    </>
  );
}
