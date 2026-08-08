import { isZodScript, parseZodSchemaPaths } from '@/innovation/agent_zod';

const SAMPLE_SCRIPT = `import { registerMvuSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

export const Schema = z.object({
  世界: z.object({
    当前时间: z.string().prefault('未知'),
    当前地点: z.string().prefault('未知'),
    危机程度: z.string().prefault('无'),
    遭遇冷却: z.coerce.number().catch(0).prefault(0),
    动向: z.record(
      z.string().describe('事件标题'),
      z.object({
        阶段: z.enum(['起', '承', '转', '合']).catch('起').prefault('起'),
        类型: z.string().prefault('未知'),
      })
    ).prefault({}),
  }).catch({}).prefault({}),

  主角: z.object({
    姓名: z.string().prefault('未知'),
    境界: z.string().prefault('凡人（DC:0）'),
    生命: z.coerce.number().catch(100).prefault(100),
    炼丹: z.object({
      阶级: z.string().catch('未入门').prefault('未入门'),
      熟练度: z.coerce.number().catch(0).prefault(0),
    }).catch({}).prefault({}),
    储物袋: z.record(
      z.string().describe('物品名'),
      z.object({
        描述: z.string().prefault(''),
        数量: z.coerce.number().catch(1).prefault(1),
      })
    ).prefault({}),
  }).catch({}).prefault({}),

  道侣: z.record(
    z.string().describe('道侣姓名'),
    z.object({
      亲密: z.coerce.number().catch(100).prefault(100),
      心声: z.string().prefault('无'),
    })
  ).catch({}).prefault({}),

  $器灵台词: z.array(z.string()).prefault([]),
});`;

describe('isZodScript（ZOD 脚本识别）', () => {
    test('识别 registerMvuSchema 导入', () => {
        expect(isZodScript(SAMPLE_SCRIPT)).toBe(true);
        expect(isZodScript('import { registerMvuSchema } from "https://x/mvu_zod.js";')).toBe(true);
    });

    test('普通脚本不算 ZOD', () => {
        expect(isZodScript('const x = 1; $(() => { toastr.info("hi"); });')).toBe(false);
        expect(isZodScript('')).toBe(false);
    });
});

describe('parseZodSchemaPaths（ZOD 变量仓库路径枚举）', () => {
    test('嵌套 z.object 路径', () => {
        const paths = parseZodSchemaPaths(SAMPLE_SCRIPT);
        expect(paths).toContain('世界.当前时间');
        expect(paths).toContain('世界.当前地点');
        expect(paths).toContain('世界.遭遇冷却');
        expect(paths).toContain('主角.姓名');
        expect(paths).toContain('主角.境界');
        expect(paths).toContain('主角.生命');
        expect(paths).toContain('主角.炼丹.阶级');
        expect(paths).toContain('主角.炼丹.熟练度');
    });

    test('record 动态容器：容器本身 + 子字段模板路径', () => {
        const paths = parseZodSchemaPaths(SAMPLE_SCRIPT);
        expect(paths).toContain('世界.动向');
        expect(paths).toContain('世界.动向.<键>.阶段');
        expect(paths).toContain('主角.储物袋');
        expect(paths).toContain('主角.储物袋.<键>.数量');
        expect(paths).toContain('道侣');
        expect(paths).toContain('道侣.<键>.亲密');
    });

    test('$ 开头键', () => {
        expect(parseZodSchemaPaths(SAMPLE_SCRIPT)).toContain('$器灵台词');
    });

    test('顶层直接键', () => {
        const paths = parseZodSchemaPaths(SAMPLE_SCRIPT);
        expect(paths).toContain('世界');
        expect(paths).toContain('主角');
    });

    test('值里的冒号/引号不干扰键解析', () => {
        // 默认值带冒号（凡人（DC:0））已在 SAMPLE 覆盖
        const paths = parseZodSchemaPaths(SAMPLE_SCRIPT);
        expect(paths).toContain('主角.境界');
    });

    test('非 ZOD 脚本返回空', () => {
        expect(parseZodSchemaPaths('const x = 1;')).toEqual([]);
        expect(parseZodSchemaPaths('')).toEqual([]);
    });

    test('去重保序', () => {
        const paths = parseZodSchemaPaths(SAMPLE_SCRIPT);
        expect(new Set(paths).size).toBe(paths.length);
    });
});
