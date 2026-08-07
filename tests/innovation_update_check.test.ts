import {
    checkForUpdates,
    compareVersions,
    extractLatestTag,
    UpdateCheckResult,
} from '@/innovation/update_check';
import { buildCdnUrl, INNOVATION_VERSION } from '@/innovation/version';

/** 模拟 fetch 返回 */
function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
    return (async () => {
        return {
            ok,
            status,
            json: async () => payload,
        } as Response;
    }) as typeof fetch;
}

describe('innovation version helpers', () => {
    test('buildCdnUrl 生成 jsDelivr URL', () => {
        expect(buildCdnUrl('v1.1.0')).toBe(
            'https://cdn.jsdelivr.net/gh/NLKASHEI/MVU-Innovation@v1.1.0/artifact/bundle.js'
        );
    });

    test('buildCdnUrl 容忍 @ 前缀与空白', () => {
        expect(buildCdnUrl(' @v1.0.0 ')).toBe(
            'https://cdn.jsdelivr.net/gh/NLKASHEI/MVU-Innovation@v1.0.0/artifact/bundle.js'
        );
    });

    test('buildCdnUrl 空版本返回空串', () => {
        expect(buildCdnUrl('')).toBe('');
        expect(buildCdnUrl('  ')).toBe('');
    });

    test('当前内置版本号非空且形如 v1.x.y', () => {
        expect(INNOVATION_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    });
});

describe('innovation compareVersions', () => {
    test('数字分段比较', () => {
        expect(compareVersions('v1.2.3', 'v1.2.2')).toBeGreaterThan(0);
        expect(compareVersions('v1.2.2', 'v1.2.3')).toBeLessThan(0);
        expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
    });

    test('缺段时按 0 补齐', () => {
        expect(compareVersions('v1.2', 'v1.2.0')).toBe(0);
        expect(compareVersions('v1.2', 'v1.2.1')).toBeLessThan(0);
    });

    test('大小写 v 前缀容忍', () => {
        expect(compareVersions('V1.2.3', 'v1.2.3')).toBe(0);
    });

    test('数字段大于字符串段', () => {
        expect(compareVersions('v1.2.3', 'v1.2.alpha')).toBeGreaterThan(0);
    });
});

describe('innovation extractLatestTag', () => {
    test('取第一个 tag 名', () => {
        expect(extractLatestTag([{ name: 'v1.2.0' }, { name: 'v1.1.0' }])).toBe('v1.2.0');
    });

    test('非数组回退空串', () => {
        expect(extractLatestTag(null)).toBe('');
        expect(extractLatestTag({})).toBe('');
        expect(extractLatestTag('x')).toBe('');
    });

    test('首个条目缺 name 回退空串', () => {
        expect(extractLatestTag([{}])).toBe('');
        expect(extractLatestTag([])).toBe('');
    });
});

describe('innovation checkForUpdates', () => {
    test('有新版：hasUpdate=true 且 url 指向最新版', async () => {
        const result = await checkForUpdates(
            mockFetch([{ name: 'v9.9.9' }]),
            'v1.1.0'
        );
        expect(result.ok).toBe(true);
        expect(result.hasUpdate).toBe(true);
        expect(result.latest).toBe('v9.9.9');
        expect(result.url).toContain('@v9.9.9/');
    });

    test('已是最新：hasUpdate=false 且 url 指向当前版', async () => {
        const result = await checkForUpdates(
            mockFetch([{ name: 'v1.1.0' }]),
            'v1.1.0'
        );
        expect(result.ok).toBe(true);
        expect(result.hasUpdate).toBe(false);
        expect(result.latest).toBe('v1.1.0');
        expect(result.url).toContain('@v1.1.0/');
    });

    test('远程版本更旧也算无更新', async () => {
        const result = await checkForUpdates(
            mockFetch([{ name: 'v1.0.0' }]),
            'v1.1.0'
        );
        expect(result.ok).toBe(true);
        expect(result.hasUpdate).toBe(false);
    });

    test('HTTP 非 2xx 报错且 ok=false', async () => {
        const result = await checkForUpdates(
            mockFetch({ message: 'rate limited' }, false, 403),
            'v1.1.0'
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('403');
    });

    test('响应无 tag 报错', async () => {
        const result = await checkForUpdates(mockFetch([]), 'v1.1.0');
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
    });

    test('fetch 抛异常 ok=false 且 error 有值', async () => {
        const failing = (async () => {
            throw new Error('network down');
        }) as typeof fetch;
        const result = await checkForUpdates(failing, 'v1.1.0');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('network down');
    });

    test('结果携带 checkedAt 时间戳', async () => {
        const result = await checkForUpdates(mockFetch([{ name: 'v1.1.0' }]), 'v1.1.0');
        expect(typeof result.checkedAt).toBe('number');
        expect(result.checkedAt).toBeGreaterThan(0);
    });

    test('ok=false 时仍带 current 与 checkedAt', async () => {
        const result: UpdateCheckResult = await checkForUpdates(
            mockFetch([], false, 500),
            'v1.1.0'
        );
        expect(result.ok).toBe(false);
        expect(result.current).toBe('v1.1.0');
        expect(result.checkedAt).toBeGreaterThan(0);
    });
});
