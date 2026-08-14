const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/auth/login" && request.method === "POST") {
        const { password } = await request.json();
        if (typeof password !== "string" || !(await secureEqual(password, env.ADMIN_PASSWORD))) {
          return json({ error: "用户名或密码错误" }, 401, cors);
        }
        return json({ token: await signSession(env), expiresIn: SESSION_TTL_SECONDS }, 200, cors);
      }
      if (url.pathname === "/navigation") {
        await requireAdmin(request, env);
        if (request.method === "GET") return githubRead(env, cors);
        if (request.method === "PUT") return githubWrite(request, env, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "服务暂时不可用";
      return json({ error: message }, status, cors);
    }
  }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.ALLOWED_ORIGIN) return {};
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "vary": "Origin"
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...cors } });
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function secureEqual(left, right) {
  if (typeof right !== "string") return false;
  const leftHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)));
  const rightHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)));
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.max(leftHash.length, rightHash.length); index++) {
    difference |= (leftHash[index] ?? 0) ^ (rightHash[index] ?? 0);
  }
  return difference === 0;
}

async function signSession(env) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })));
  return `${payload}.${toBase64Url(await hmac(payload, env.SESSION_SECRET))}`;
}

async function requireAdmin(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !token.includes(".")) throw new HttpError(401, "请先登录");
  const [payload, signature] = token.split(".");
  const expected = toBase64Url(await hmac(payload, env.SESSION_SECRET));
  if (!(await secureEqual(signature, expected))) throw new HttpError(401, "登录已失效");
  const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  if (!Number.isInteger(data.exp) || data.exp < Math.floor(Date.now() / 1000)) throw new HttpError(401, "登录已过期");
}

function githubRequest(env, path, options = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
    ...options,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2026-03-10",
      ...options.headers
    }
  });
}

async function githubRead(env, cors) {
  const response = await githubRequest(env, env.NAVIGATION_PATH, { headers: { "cache-control": "no-store" } });
  if (!response.ok) throw new HttpError(502, "无法读取 GitHub 导航数据");
  const file = await response.json();
  const content = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g, "")), char => char.charCodeAt(0)));
  return json({ content, sha: file.sha }, 200, cors);
}

async function githubWrite(request, env, cors) {
  const { content, sha } = await request.json();
  if (typeof content !== "string" || !content.trim() || content.length > 100_000) throw new HttpError(400, "导航数据不能为空且不能超过 100 KB");
  try { JSON.parse(content); } catch { throw new HttpError(400, "导航数据必须是有效 JSON"); }
  if (typeof sha !== "string" || !sha) throw new HttpError(409, "数据已过期，请重新加载后再保存");
  const response = await githubRequest(env, env.NAVIGATION_PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "content: update protected navigation", content: btoa(unescape(encodeURIComponent(content))), sha, branch: env.GITHUB_BRANCH })
  });
  if (response.status === 409 || response.status === 422) throw new HttpError(409, "GitHub 内容已变更，请重新加载后再保存");
  if (!response.ok) throw new HttpError(502, "无法提交到 GitHub");
  const result = await response.json();
  return json({ ok: true, sha: result.content.sha, commit: result.commit.html_url }, 200, cors);
}
