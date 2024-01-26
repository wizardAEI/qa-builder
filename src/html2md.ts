import { NodeHtmlMarkdown } from 'node-html-markdown'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { __dirname } from './util'


// 根据链接获取html
const html = await fetch('https://cloud.baidu.com/doc/AIHC/s/cliv5r4zm').then(res => res.text())

const md = NodeHtmlMarkdown.translate(
    html, 
)

// 新建文件并写入
writeFileSync(join(__dirname, '../', 'md_file', 'file.md'), md)

