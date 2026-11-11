import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";

// Exercise the actual CAS sender with school responses, without sending real codes.
const source = (await fs.readFile(new URL("../lib/szu/cas.ts", import.meta.url), "utf8"))
  .replace('"../set-cookie.mjs"', JSON.stringify(new URL("../lib/set-cookie.mjs", import.meta.url).href));
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { CookieJar, sendReAuthCode } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const originalFetch = globalThis.fetch;
const ctx = { reAuthType: "3", reAuthUserId: "test-user" };
let requests = 0;
try {
  for (const [status, res, expected] of [
    [200, "success", true], [200, "unsuccessful", false],
    [200, "not_success", false], [503, "success", false], [200, "", false],
  ]) {
    globalThis.fetch = async (_url, init) => {
      requests++;
      assert.equal(new URLSearchParams(init.body).get("authCodeTypeName"), "reAuthDynamicCodeType");
      return new Response(JSON.stringify({ res }), { status });
    };
    assert.equal((await sendReAuthCode(new CookieJar(), ctx)).ok, expected, `${status}: ${res}`);
  }
  const before = requests;
  assert.equal((await sendReAuthCode(new CookieJar(), { ...ctx, reAuthType: "unknown" })).ok, false);
  assert.equal((await sendReAuthCode(new CookieJar(), { ...ctx, reAuthUserId: "" })).ok, false);
  assert.equal(requests, before, "invalid context must not trigger a code request");
  console.log("MFA send: 7 cases passed");
} finally {
  globalThis.fetch = originalFetch;
}
