// 仅用于离线单文件构建的入口:
// 以副作用方式加载主入口, 并导出一个默认值, 强制 webpack 输出 ESM `export`,
// 保证产物与线上 bundle.js / 原 offline 文件一样是显式 ESM 模块。
import './main';

export default {};
