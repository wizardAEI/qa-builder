import typescript from 'rollup-plugin-typescript2';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import dotenv from "rollup-plugin-dotenv"

export default [{
  input: 'src/convert.ts', // 你的入口文件
  output: {
    file: 'dist/convert.js', // 输出的文件路径和名称
    format: 'esm' // ESM
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      tsconfig: 'tsconfig.json' // 指定TypeScript配置文件
    }),
    json(),
    dotenv()
  ]
}, {
  input: 'src/html2md.ts', // 你的入口文件
  output: {
    file: 'dist/html2md.js', // 输出的文件路径和名称
    format: 'esm'
  },
  plugins: [
    resolve(),
    commonjs(),
    typescript({
      tsconfig: 'tsconfig.json' // 指定TypeScript配置文件
    }),
    json(),
    dotenv()
  ]
}];
