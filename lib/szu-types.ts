/** 本机登录态的样子。服务端 token 里的字段子集，前端只用它渲染，不做鉴权判断。 */
export interface SzUser {
  studentId: string;
  name: string;
  college: string;
  major: string;
  grade: string;
  level: string;
  expiresAt?: string;
}
