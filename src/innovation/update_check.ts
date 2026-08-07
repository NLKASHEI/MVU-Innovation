/**
 * [革新版·更新检查] 纯逻辑模块。
 *
 * 通过 GitHub API 查询仓库最新 tag，与当前内置版本比较，判断是否有新版。
 * fetch 以参数注入，便于单测（浏览器真实场景由 update_check_bridge 传入全局 fetch）。
 *
 * 版本比较规则：按语义化数字分段比较（v1.2.3 > v1.2.2）；无数字部分时回退字符串比较。
 */

import { INNOVATION_BUNDLE_PATH, INNOVATION_REPO } from '@/innovation/version';

/** 更新检查结果 */
export interface UpdateCheckResult {
    /** 是否成功完成检查（网络/解析失败为 false） */
    ok: boolean;
    /** 仓库最新版本号 */
    latest: string;
    /** 当前内置版本号 */
    current: string;
    /** 是否有可更新的新版 */
    hasUpdate: boolean;
    /** 最新版完整 CDN URL（有新版时给出，否则为当前版本 URL） */
    url: string;
    /** 检查时间（epoch ms） */
    checkedAt: number;
    /** 失败原因（ok=false 时） */
    error?: string;
}

/** GitHub API 响应中的单个 tag 条目 */
interface GitHubTagEntry {
    name?: string;
}

/**
 * 语义化版本比较：v1.2.3 与 v1.2.2。
 * @returns >0 表示 a 更新；<0 表示 b 更新；0 表示相同。
 */
export function compareVersions(a: string, b: string): number {
    const norm = (v: string) => String(v).trim().replace(/^v/i, '');
    const split = (v: string): Array<number | string> =>
        norm(v)
            .split(/[.\-_]/)
            .filter(Boolean)
            .map(seg => (/^\d+$/.test(seg) ? Number(seg) : seg));

    const pa = split(a);
    const pb = split(b);
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (typeof x === 'number' && typeof y === 'number') {
            if (x !== y) return x - y;
        } else if (typeof x === 'string' && typeof y === 'string') {
            if (x !== y) return x.localeCompare(y);
        } else {
            // 数字段永远大于字符串段（v1.2 > v1.2.alpha）
            if (typeof x === 'number') return 1;
            if (typeof y === 'number') return -1;
        }
    }
    return 0;
}

/**
 * 从 GitHub API 响应中提取最新 tag 名。
 * @param payload 已 JSON.parse 的响应体
 */
export function extractLatestTag(payload: unknown): string {
    if (!Array.isArray(payload)) return '';
    const first = payload[0] as GitHubTagEntry | undefined;
    if (!first || typeof first.name !== 'string' || !first.name.trim()) return '';
    return first.name.trim();
}

/**
 * 执行更新检查（纯逻辑）。
 * @param fetchFn fetch 实现（单测可 mock）
 * @param currentVersion 当前内置版本号
 * @param repo GitHub 仓库
 */
export async function checkForUpdates(
    fetchFn: typeof fetch,
    currentVersion: string,
    repo = INNOVATION_REPO
): Promise<UpdateCheckResult> {
    const base: UpdateCheckResult = {
        ok: false,
        latest: '',
        current: currentVersion,
        hasUpdate: false,
        url: '',
        checkedAt: Date.now(),
    };

    try {
        const res = await fetchFn(
            `https://api.github.com/repos/${repo}/tags?per_page=1`,
            { headers: { Accept: 'application/vnd.github+json' } }
        );
        if (!res.ok) {
            return { ...base, error: `GitHub API HTTP ${res.status}` };
        }
        const payload: unknown = await res.json();
        const latest = extractLatestTag(payload);
        if (!latest) {
            return { ...base, error: '仓库暂无 tag（无法提供版本号更新）' };
        }

        const hasUpdate = compareVersions(latest, currentVersion) > 0;
        const version = hasUpdate ? latest : currentVersion;
        return {
            ok: true,
            latest,
            current: currentVersion,
            hasUpdate,
            url: `https://cdn.jsdelivr.net/gh/${repo}@${version}/${INNOVATION_BUNDLE_PATH}`,
            checkedAt: Date.now(),
        };
    } catch (e) {
        return {
            ...base,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
