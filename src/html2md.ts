import { NodeHtmlMarkdown } from 'node-html-markdown'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { __dirname } from './util'
import { config } from 'dotenv';
config()


// 根据链接获取html
const html = await fetch(process.env.DOC_URL || '').then(res => res.text())

const md = NodeHtmlMarkdown.translate(
    html, 
)
// 新建文件夹
const path = join(__dirname, '../', 'md_file')
if (!existsSync(path)) {
    mkdirSync(path)
}
// 新建文件并写入
writeFileSync(join(__dirname, '../', 'md_file', 'file.md'), md)

