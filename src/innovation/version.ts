/**
 * [革新版] 版本与发布信息。
 *
 * 发版流程（每次更新时必须同步做三件事）：
 *  1. 更新 INNOVATION_VERSION（递增为下一个 tag，如 v1.1.0 -> v1.1.1 / v1.2.0）
 *  2. git 打同名 tag（如 v1.1.1）并推送
 *  3. 告知用户新的 jsDelivr URL（面板「检查更新」也会自动给出）
 *
 * jsDelivr 对 tag 的缓存是 immutable 的（同一 tag 内容不变），
 * 因此用 @<tag> 的 URL 绝不会拿到旧版本——这是相对 @main（分支缓存最长 12h）的根治方案。
 */

/** 当前版本号（与 git tag 保持一致） */
export const INNOVATION_VERSION = 'v1.11.0';

/** 发布仓库（GitHub 完整路径） */
export const INNOVATION_REPO = 'NLKASHEI/MVU-Innovation';

/** bundle 产物在仓库内的路径 */
export const INNOVATION_BUNDLE_PATH = 'artifact/bundle.js';

/**
 * 构建 jsDelivr CDN URL。
 * @param version 版本（如 'v1.1.0'，也可传分支/commit，如 'main'、'd4eb5c8'）
 * @param repo GitHub 仓库，默认革新版仓库
 */
export function buildCdnUrl(version: string, repo = INNOVATION_REPO): string {
    const clean = String(version).trim().replace(/^@/, '');
    if (!clean) return '';
    return `https://cdn.jsdelivr.net/gh/${repo}@${clean}/${INNOVATION_BUNDLE_PATH}`;
}
