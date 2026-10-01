/** 只用于识别客户端缓存是否换代；身份与签名仍由服务端 RPC 验证。 */
export function authSessionIdentity(accessToken: string | undefined): string | null {
  if (!accessToken) return null;
  try {
    const payload = accessToken.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.session_id === "string" && /^[0-9a-f-]{36}$/i.test(json.session_id) ? json.session_id : null;
  } catch { return null; }
}
