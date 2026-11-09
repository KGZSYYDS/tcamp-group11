/**
 * 个人数据的归属键（**只在 --publish 写云库时才用到**）。
 *
 * 常规路径已经不走这里了：课表和群聊待办写成 data/ 下的本机文件，网页导入后进
 * localStorage，归属由「谁的浏览器就是谁的」天然保证，不需要任何键。
 *
 * 保留它的唯一场景是显式 --publish：采集器用的是云服务里公开可发布的前端密钥，
 * 写进 events 表的 owner_id 只能是 "anon"，此时才需要 source_url 里带一个键，
 * 让前端认出「这批行属于谁」。
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
