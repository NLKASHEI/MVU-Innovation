// webpack.config.js
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
    entry: './example_src/src/main.ts',
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /iframe_client/,
                use: 'ts-loader'
            }
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
        }
    },
    output: {
        filename: 'example_bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    externals: [
        // 这里的函数将拦截所有请求，“slash-runner/”开头的模块都不会被打包
        function({ request }, callback) {
            callback();

        }
    ],
    plugins: [
        new webpack.ProvidePlugin({
            // 当全局使用 toml 变量时自动加载 toml 模块
            toml: 'toml'
        }),

    ],
    mode: 'development',
    devtool: 'source-map', // 添加这一行，启用 source map
    optimization: {
        usedExports: false
    }
};
