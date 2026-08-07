/**
 * [革新版·更新检查] 运行时桥接层。
 *
 * 用浏览器全局 fetch 查询 GitHub tags API，供面板「检查更新」按钮调用。
 * 纯逻辑在 update_check.ts（可单测），本文件仅做真实环境接入。
 */

import { checkForUpdates, UpdateCheckResult } from '@/innovation/update_check';
import { INNOVATION_REPO, INNOVATION_VERSION } from '@/innovation/version';

/** 最近一次检查结果（供面板显示） */
let last_update_check: UpdateCheckResult | null = null;

/** 是否正在检查（防止重复点击） */
let checking = false;

export function getLastUpdateCheck(): UpdateCheckResult | null {
    return last_update_check;
}

export function isCheckingUpdates(): boolean {
    return checking;
}

/**
 * 手动触发一次更新检查。
 * @param customFetch 测试/调试用 fetch，缺省用全局 fetch
 */
export async function checkForUpdatesNow(
    customFetch?: typeof fetch
): Promise<UpdateCheckResult> {
    if (checking) {
        return (
            last_update_check ?? {
                ok: false,
                latest: '',
                current: INNOVATION_VERSION,
                hasUpdate: false,
                url: '',
                checkedAt: Date.now(),
                error: '检查进行中',
            }
        );
    }
    checking = true;
    try {
        const result = await checkForUpdates(
            customFetch ?? fetch,
            INNOVATION_VERSION,
            INNOVATION_REPO
        );
        last_update_check = result;
        return result;
    } finally {
        checking = false;
    }
}
