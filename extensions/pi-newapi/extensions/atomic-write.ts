/**
 * 原子写 JSON 的小工具：先写临时文件、再 rename 覆盖目标，双保险防写坏——
 * 即便中途中断，也只会留在临时文件，正式文件永远不会被写一半。
 *
 * 针对 Windows 下「目标被其它进程占用导致 renameSync 抛 EPERM/EBUSY」做了：
 *   1. 数次短退避重试（缓解防病毒/瞬时占用）；
 *   2. 最终失败时删除临时文件，绝不遗留孤儿 .tmp（本次改造的核心目标）；
 *   3. 持续失败输出一次性告警，避免排障时把「陈旧但未报错」误判为正常。
 *
 * 已知限制：短退避无法根治「另一 pi 进程长持有目标句柄」的并发竞争，
 * 真正的收敛方案是跨进程锁或单一写者（见 index.ts refreshCatalog 的单写者说明）。
 */
import { dirname } from "node:path";
import { writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";

export const WRITE_RETRIES = 5;
export const WRITE_BACKOFF_BASE_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 持续失败只告警一次/路径，避免高频刷新时刷屏。 */
const warnedPaths = new Set<string>();
function warnOnce(path: string, err: unknown): void {
  if (warnedPaths.has(path)) return;
  warnedPaths.add(path);
  console.warn(
    `[pi-newapi] 原子写失败（临时文件已清理，本次未写入）：${path} — ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

/**
 * 原子写 JSON。
 * @param path            目标文件绝对路径（其父目录会自动创建）。
 * @param data            将被 JSON.stringify 后写入的数据。
 * @param trailingNewline 是否在文末补一个换行。
 * @returns               是否写入成功；false 表示最终失败（临时文件已清理，无孤儿）。
 */
export async function writeJsonAtomic(
  path: string,
  data: unknown,
  trailingNewline: boolean,
): Promise<boolean> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let lastErr: unknown;
  try {
    // 创建父目录也放进保护圈：失败时和写失败一样走清理 + 返回 false，绝不对外抛错
    // （避免 /newapi-url 保存、启动后台写等调用路径出现未捕获异常/无声崩溃）。
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      tmpPath,
      JSON.stringify(data, null, 2) + (trailingNewline ? "\n" : ""),
      "utf-8",
    );
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
      try {
        renameSync(tmpPath, path);
        return true;
      } catch (err) {
        lastErr = err;
        await sleep(WRITE_BACKOFF_BASE_MS * (attempt + 1));
      }
    }
    throw lastErr;
  } catch (err) {
    // 失败后必清临时文件，杜绝孤儿 .tmp 堆积
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* 清理失败也尽力而为 */
    }
    warnOnce(path, err);
    return false;
  }
}