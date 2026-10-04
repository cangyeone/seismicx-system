import { useState } from "react";
import { ShieldCheck, ArrowRight, ArrowLeft } from "lucide-react";
import { post, setCSRF } from "./api";
import type { AdminSession } from "./auth";
export default function Access({
  onReady,
  onBack,
}: {
  onReady: (session: AdminSession) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="admin-access">
      <section className="panel access-panel">
        <ShieldCheck size={34} className="teal" />
        <h1>后台管理</h1>
        <p className="muted">登录后管理算法参数、台站与地震目录。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const session = await post<AdminSession>("/auth/login", {
                username,
                password,
              });
              setCSRF(session.csrf || "");
              setPassword("");
              onReady(session);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            用户名
            <input
              autoComplete="username"
              required
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "登录中…" : "登录后台"}
            <ArrowRight size={16} />
          </button>
        </form>
        <button onClick={onBack}>
          <ArrowLeft size={15} />
          返回公开监测
        </button>
        <small className="muted">公开台站、目录与动画无需登录。</small>
      </section>
    </div>
  );
}
