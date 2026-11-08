/**
 * 个人数据的归属键。
 *
 * 采集器跑在用户本机、用的是云服务里公开可发布的前端密钥，写进 events 表的
 * owner_id 只能是 "anon"。为了让「个人课表」「群聊会议」只对本人可见，做法是：
 *
 *   source_url 里放 <归属键>，用户登录后在「我的」页填一次学号认领，
 *   前端算出同一个键，把这批行的 owner_id 改成该账号的 uid。
 *
 * 归属键 = SHA-256(学号) 前 16 位。学号明文不进库——events 表是公开可读的，
 * 而学号 + 姓名是能反查到人的。
 *
 * 同一份实现也在 lib/data.ts（浏览器侧用的是 WebCrypto，算法一致）。
 */
import crypto from "node:crypto";

export function ownerKeyOf(id) {
  if (!id) return "-";
  return crypto.createHash("sha256").update(String(id).trim()).digest("hex").slice(0, 16);
}

/** 群名 → 短哈希，用于 source_url 里标注来源群，又不必把群名写进公开表 */
export function groupKeyOf(name) {
  if (!name) return "-";
  return crypto.createHash("sha256").update(String(name).trim()).digest("hex").slice(0, 8);
}
