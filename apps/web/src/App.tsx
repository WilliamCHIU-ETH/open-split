import { plannedHttpRoutes } from "@open-split/contracts";

export function App() {
  return (
    <div className="min-h-dvh bg-stone-50 text-stone-950">
      <a
        href="#ledger"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:bg-white focus:px-3 focus:py-2 focus:underline"
      >
        跳到主要內容
      </a>
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-lg flex-col gap-1 px-4 py-5">
          <p className="text-sm font-medium text-stone-700">open-split</p>
          <p className="text-sm text-stone-700">分帳帳本。這個畫面還是空殼。</p>
        </div>
      </header>
      <main id="ledger" className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">帳本還沒有做</h1>
        <p className="text-base leading-7 text-stone-800">
          切片 1 才會在這裡記平均分帳、看餘額。在 LINE 裡打開時，這也是同一套帳本，不是另一個只能收通知的畫面。
        </p>
        <section aria-labelledby="routes-heading" className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 id="routes-heading" className="text-base font-semibold">
            預定的 API
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm leading-6 text-stone-800">
            {plannedHttpRoutes.map((route) => (
              <li key={`${route.method} ${route.path}`}>
                <span className="font-medium">{route.summary}</span>
                <span className="text-stone-600">
                  {" "}
                  · {route.method} {route.path}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
