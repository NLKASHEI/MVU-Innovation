import {
    INNOVATION_DEFAULTS,
    loadInnovationSettings,
    parseInnovationSettings,
    saveInnovationSettings,
    updateInnovationSettings,
} from '@/innovation/settings';

function memoryStorage(): Storage & { _data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
        _data: data,
        getItem: (k: string) => (k in data ? data[k] : null),
        setItem: (k: string, v: string) => {
            data[k] = v;
        },
        removeItem: (k: string) => {
            delete data[k];
        },
        clear: () => {
            Object.keys(data).forEach(k => delete data[k]);
        },
        key: (i: number) => Object.keys(data)[i] ?? null,
        get length() {
            return Object.keys(data).length;
        },
    } as any;
}

describe('innovation settings', () => {
    test('默认值', () => {
        expect(INNOVATION_DEFAULTS.agentEnabled).toBe(false);
        expect(INNOVATION_DEFAULTS.maxSteps).toBe(3);
        expect(INNOVATION_DEFAULTS.loopThreshold).toBe(3);
        expect(INNOVATION_DEFAULTS.cacheMetricsEnabled).toBe(true);
    });

    test('parse 容错：非对象回退默认', () => {
        expect(parseInnovationSettings(null)).toEqual(INNOVATION_DEFAULTS);
        expect(parseInnovationSettings('x')).toEqual(INNOVATION_DEFAULTS);
    });

    test('parse 正确读取并夹取边界', () => {
        const parsed = parseInnovationSettings({
            agentEnabled: true,
            maxSteps: 99,
            loopThreshold: 0,
            cacheMetricsEnabled: false,
        });
        expect(parsed.agentEnabled).toBe(true);
        expect(parsed.maxSteps).toBe(10); // 夹取到 max
        expect(parsed.loopThreshold).toBe(2); // 夹取到 min
        expect(parsed.cacheMetricsEnabled).toBe(false);
    });

    test('load 无数据时回退默认', () => {
        const storage = memoryStorage();
        expect(loadInnovationSettings(storage)).toEqual(INNOVATION_DEFAULTS);
    });

    test('save + load 往返一致', () => {
        const storage = memoryStorage();
        const settings = { ...INNOVATION_DEFAULTS, agentEnabled: true, maxSteps: 5 };
        saveInnovationSettings(storage, settings);
        expect(loadInnovationSettings(storage)).toEqual(settings);
    });

    test('load 解析坏 JSON 时回退默认', () => {
        const storage = memoryStorage();
        storage.setItem('nlkaleido:innovation', '{bad json');
        expect(loadInnovationSettings(storage)).toEqual(INNOVATION_DEFAULTS);
    });

    test('updateInnovationSettings 合并部分字段', () => {
        const merged = updateInnovationSettings(INNOVATION_DEFAULTS, { agentEnabled: true });
        expect(merged.agentEnabled).toBe(true);
        expect(merged.maxSteps).toBe(INNOVATION_DEFAULTS.maxSteps);
    });
});
