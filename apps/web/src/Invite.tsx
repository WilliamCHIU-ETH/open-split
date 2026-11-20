export function Invite() {
  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        邀請連結
      </h1>
      <p>這條連結已經建立。朋友從這裡認領自己的成員，是之後才會做的事。現在還不能用這條連結加入群組。</p>
      <p>
        <a href="/" className="button">
          回到帳本
        </a>
      </p>
    </>
  );
}
