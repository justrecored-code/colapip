/**
 * 微信 iLink Bot API 客户端 — 从 CipherTalk/OpenClaw 协议移植。
 * 纯 HTTP 调用，零外部依赖（Node built-in fetch + crypto）。
 * 参考: Tencent/openclaw-weixin
 */
import crypto from "crypto";

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const CHANNEL_VERSION = "2.4.4";
const ILINK_APP_ID = "bot";
const BOT_AGENT = "OpenClaw";

function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0, minor = parts[1] ?? 0, patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CHANNEL_VERSION));

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

function buildBaseInfo(): Record<string, string> {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
  const res = await fetch(url, { headers: commonHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function apiPost<T>(
  baseUrl: string, endpoint: string, body: Record<string, unknown>,
  token?: string, timeoutMs = 15_000, signal?: AbortSignal,
): Promise<T | null> {
  const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`;
  const payload = { ...body, base_info: buildBaseInfo() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return null;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ── Types ──

export interface IlinkSession {
  token: string;
  baseUrl: string;
  botId: string;
  userId: string;
}

export interface IlinkQrcode {
  qrcode: string;
  qrcodeContent: string;
}

export type IlinkQrStatus = "wait" | "scaned" | "expired" | "confirmed";

export interface IlinkQrStatusResp {
  status: IlinkQrStatus;
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

export interface IlinkMessage {
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  context_token?: string;
  item_list?: Array<{ type: number; text_item?: { text?: string } }>;
}

export interface IlinkUpdates {
  ret?: number;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

// ── API ──

export async function fetchQrcode(): Promise<IlinkQrcode> {
  const resp = await apiGet<{ qrcode: string; qrcode_img_content: string }>(
    ILINK_BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
  );
  return { qrcode: resp.qrcode, qrcodeContent: resp.qrcode_img_content };
}

export async function fetchQrcodeStatus(qrcode: string): Promise<IlinkQrStatusResp> {
  return apiGet<IlinkQrStatusResp>(
    ILINK_BASE_URL, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
  );
}

export async function notifyStart(session: IlinkSession): Promise<{ ret?: number; errmsg?: string } | null> {
  return apiPost<{ ret?: number; errmsg?: string }>(session.baseUrl, "ilink/bot/msg/notifystart", {}, session.token, 10_000);
}

export async function notifyStop(session: IlinkSession): Promise<{ ret?: number; errmsg?: string } | null> {
  return apiPost<{ ret?: number; errmsg?: string }>(session.baseUrl, "ilink/bot/msg/notifystop", {}, session.token, 10_000);
}

/** 长轮询取新消息（服务器 hold ~35s，这里 38s 超时） */
export async function getUpdates(session: IlinkSession, buf: string, signal?: AbortSignal): Promise<IlinkUpdates> {
  const resp = await apiPost<IlinkUpdates>(
    session.baseUrl, "ilink/bot/getupdates",
    { get_updates_buf: buf ?? "" }, session.token, 38_000, signal,
  );
  return resp ?? { ret: 0, msgs: [], get_updates_buf: buf };
}

/** 发送文本消息 */
export async function sendText(
  session: IlinkSession, toUserId: string, text: string, contextToken?: string,
): Promise<void> {
  await apiPost(session.baseUrl, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `vp-${crypto.randomUUID()}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  }, session.token);
}

/** 提取消息文本 */
export function extractText(msg: IlinkMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) return item.text_item.text;
  }
  return "";
}

// ── Media upload helpers ──

import { createCipheriv } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { basename, extname } from "path";

function createFileKey(fileName: string): string {
  const ext = extname(fileName).replace(/[^a-z0-9.]/gi, "").slice(0, 16);
  return `${crypto.randomBytes(16).toString("hex")}${ext}`;
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export async function sendImage(
  session: IlinkSession, toUserId: string, filePath: string, contextToken?: string,
): Promise<void> {
  if (!existsSync(filePath)) throw new Error(`图片不存在: ${filePath}`);
  const stat = statSync(filePath);
  if (stat.size <= 0 || stat.size > 20 * 1024 * 1024) throw new Error("图片大小超限");

  const plaintext = readFileSync(filePath);
  const rawFileMd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const aeskey = crypto.randomBytes(16);
  const filekey = createFileKey(filePath);

  const uploadUrlResp = await apiPost<any>(session.baseUrl, "ilink/bot/getuploadurl", {
    filekey, media_type: 1, to_user_id: toUserId,
    rawsize: plaintext.length, rawfilemd5: rawFileMd5,
    filesize: aesEcbPaddedSize(plaintext.length), no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  }, session.token);

  const uploadFullUrl = uploadUrlResp?.upload_full_url?.trim();
  const uploadParam = uploadUrlResp?.upload_param;
  if (!uploadFullUrl && !uploadParam) throw new Error("getuploadurl 未返回上传地址");

  const uploadUrl = uploadFullUrl || `${session.baseUrl.replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(String(uploadParam))}&filekey=${encodeURIComponent(filekey)}`;
  const encryptedBuffer = encryptAesEcb(plaintext, aeskey);

  const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(encryptedBuffer) });
  if (res.status !== 200) throw new Error(`CDN 上传失败: ${res.status}`);
  const encryptedParam = res.headers.get("x-encrypted-param");
  if (!encryptedParam) throw new Error("CDN 上传响应缺失");

  await apiPost(session.baseUrl, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "", to_user_id: toUserId,
      client_id: `vp-${crypto.randomUUID()}`,
      message_type: 2, message_state: 2, context_token: contextToken,
      item_list: [{
        type: 2,
        image_item: {
          aeskey: Buffer.from(aeskey).toString("base64"),
          media: { encrypt_query_param: encryptedParam, aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"), encrypt_type: 1 },
          mid_size: encryptedBuffer.length,
        },
      }],
    },
  }, session.token);
}

/** 判断 session 是否过期 */
export function isSessionExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("session timeout") || msg.includes("-14");
}
