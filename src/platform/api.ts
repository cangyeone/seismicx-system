let csrf = "";
export const setCSRF = (value: string) => {
  csrf = value;
};
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: response.statusText }));
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("seismicx-session-expired"));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : Array.isArray(error.detail)
          ? error.detail
              .map(
                (d: { loc?: string[]; msg: string }) =>
                  `${(d.loc || []).slice(1).join(" / ")}: ${d.msg}`,
              )
              .join("；")
          : "请求失败",
    );
  }
  return response.json();
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export function time(value: string | undefined) {
  return value
    ? new Date(value)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "")
    : "—";
}
export function value(n: number | null | undefined, digits = 1) {
  return n == null ? "—" : n.toFixed(digits);
}
export const labels: Record<string, string> = {
  online: "在线",
  disabled: "未订阅",
  waiting: "待收数",
  stale: "数据延迟",
  candidate: "待复核",
  reviewed: "已复核",
  external: "外部目录",
  manual: "人工录入",
  rejected: "已排除",
  queued: "排队中",
  running: "处理中",
  completed: "已完成",
  failed: "失败",
};
export async function download(path: string, filename: string) {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("目录导出失败");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
