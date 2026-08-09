/**
 * 针对本次「原子写」改造的回归测试：
 *   - 成功写入后不得遗留任何 .tmp 孤儿文件；
 *   - 目标被占用（rename 必失败）时，返回 false 且仍然清理临时文件、不留孤儿。
 * 运行：node --experimental-strip-types --test atomic-write.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";

function leftoverTmp(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.includes(".tmp"));
}

test("成功写入：内容落地、无 .tmp 孤儿", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-aw-test-"));
  const target = join(dir, "models.json");
  try {
    const ok = await writeJsonAtomic(target, { providers: { newapi: { models: [] } } }, true);
    assert.equal(ok, true);
    assert.equal(existsSync(target), true);
    assert.equal(leftoverTmp(dir).length, 0, "不应遗留 .tmp 临时文件");
    const parsed = JSON.parse(readFileSync(target, "utf-8"));
    assert.equal(parsed.providers.newapi.models.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("目标被占用（rename 必失败）：返回 false、无 .tmp 孤儿", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-aw-test-"));
  const target = join(dir, "models.json");
  mkdirSync(target); // 目标是目录 → rename 覆盖必失败，模拟持续占用
  try {
    const ok = await writeJsonAtomic(target, { a: 1 }, true);
    assert.equal(ok, false);
    assert.equal(leftoverTmp(dir).length, 0, "失败后必须清理 .tmp，不得遗留孤儿");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
