import markdownIt, { Token } from 'markdown-it'
import { lmInvoke } from './langchain'
import { readFileSync, writeFileSync } from 'fs'
import { __dirname } from './util'
import path from 'path'
const md = markdownIt()

interface Node {
  title: string
  content: string
  total: string
  children: Node[]
}

export function createTreeFromMarkdown(markdown: string): Node[] {
    const tree: Node[] = []
    const tokens: Token[] = md.parse(markdown, {})
    if (!tokens.find((t) => t.type === 'heading_open')) {
      let i = 0
      while (i < tokens.length) {
        if (tokens[i].type === 'inline') {
          tree.push({
            title: tokens[i].content,
            content: markdown,
            total: markdown,
            children: []
          })
          break
        }
        i++
      }
      return tree
    }
    let i = 0
    const isType = (tokenType: string) => {
      return tokens[i].type === tokenType
    }
    const splice = (a: string, b: string) => {
      if (a.length) {
        return a + '\n' + b
      }
      return b
    }
    const buildTree = (options: { nodes: Node[]; level: number; totalBefore: string }) => {
      let { nodes, level, totalBefore } = options
      while (i < tokens.length) {
        if (!isType('heading_open')) {
          i++
          continue
        }
        let content = tokens[i].markup
        while (i < tokens.length && !isType('inline')) i++
        const title = tokens[i].content
        content += ` ${tokens[i].content}`
        i++
        while (i < tokens.length && !isType('heading_open')) {
          if (isType('inline')) content += '\n' + tokens[i].content
          if (isType('fence')) {
            const fence = tokens[i]
            content += '\n' + fence.markup + fence.info + '\n' + fence.content + fence.markup
          }
          i++
        }
        const node = {
          title: title,
          content: content,
          total: '',
          children: []
        }
        nodes.push(node)
        if (i === tokens.length) {
          node.total = content
          return splice(totalBefore, content)
        }
        const levelNext = parseInt(tokens[i].tag.slice(1))
        if (levelNext > level) {
          node.total = buildTree({
            nodes: node.children,
            level: levelNext,
            totalBefore: content
          })
          totalBefore = splice(totalBefore, node.total)
          continue
        } else if (levelNext === level) {
          node.total = content
          totalBefore = splice(totalBefore, content)
          continue
        }
        node.total = content
        return splice(totalBefore, content)
      }
      return totalBefore
    }
    buildTree({ nodes: tree, level: 1, totalBefore: '' })
    writeFileSync(path.resolve(__dirname, '../json_file/tree.json'), JSON.stringify(tree))
    return tree
  }

async function getQuestionsByLM(total: string): Promise<string[]> {
    const content = (
      await lmInvoke({
        system: `我将会给你一段文字，请你根据内容提出几个问题，使用序号标出。例如我给出『小明是一个学生，他喜欢打羽毛球。』，你将回复：
  1. 小明是什么职业 
  2. 小明的爱好是什么。
  提出问题时不要延伸提问，并且确保内容可以明确的回答提出的问题；回复除了问题外不要添加任何其他内容。`,
        content: total
      })
    ).trim()
    const lines: string[] = []
    content.split('\n').forEach((line) => {
      // 判断是否以序号开头，如果是则认为该行是问题，去除序号
      if (line.match(/^[0-9]+\./)) {
        line = line.replace(/^[0-9]+\./, '')
        line && lines.push(line)
      }
    })
    return lines
  }

export interface Chunk {
indexes: { value: string }[]
document: { content: string }
}

export async function getChunkFromNodes(
    nodes: Node[],
    options: {
      chunkSize: number
      chunkOverlap: number
      useLM?: boolean
    } = {
      chunkSize: 500,
      chunkOverlap: 2 // 左右两个节点
    }
  ): Promise<Chunk[]> {
    const chunk: Chunk[] = []
    const { chunkSize, chunkOverlap } = options
    const chunkTask: number[] = []
    const split = (total: string, size: number) => {
      if (total.match(/```/)) {
        return [total]
      } else {
        // 拆分成chunkSize大小
        const lines = total.split('\n')
        let content = '',
          contents: string[] = []
        for (let i = 0; i < lines.length; i++) {
          if (content.length + lines[i].length > size) {
            contents.push(content)
            content = ''
          }
          content += lines[i] + '\n'
          if (i === lines.length - 1) {
            contents.push(content)
          }
        }
        return contents
      }
    }
  
    const dfs = (
      nodes: Node[],
      index: number,
      data?: {
        titleBefore: string
      }
    ) => {
      const node = nodes[index]
      const title = (data?.titleBefore ? data?.titleBefore + ' ' : '') + node.title
      if (node.total.length < chunkSize) {
        chunk.push({
          indexes: [{ value: node.total }, { value: title }],
          document: { content: node.total }
        })
        if (node.total !== node.content) {
          chunk[chunk.length - 1].indexes.push({ value: node.content })
        }
        // TODO: 这里使用大模型，由于时间问题后续需要加上进度功能
        if (options.useLM) {
          const index = chunk.length - 1
          chunkTask.push(index)
          console.log('task-1', index)
          getQuestionsByLM(node.total).then((questions) => {
            questions.forEach((question) => {
              chunk[index].indexes.push({ value: question })
            })
            chunkTask.splice(chunkTask.indexOf(index), 1)
          })
        }
        // TODO: 尝试加上 chunkOverlap 是否有效果
        let lapLNum = 0,
          lapRNum = 0
        while (lapLNum + lapRNum < chunkOverlap) {
          lapLNum++
          if (lapLNum <= index) {
            const n = nodes[index - lapLNum]
            if ((chunk[chunk.length - 1].document.content + '\n' + n.total).length > chunkSize) break
            chunk[chunk.length - 1].document = {
              content: n.total + '\n' + chunk[chunk.length - 1].document.content
            }
            if (lapLNum + lapRNum === chunkOverlap) break
          }
          lapRNum++
          if (index + lapRNum < nodes.length) {
            const n = nodes[index + lapRNum]
            if ((chunk[chunk.length - 1].document.content + '\n' + n.total).length > chunkSize) break
            chunk[chunk.length - 1].document = {
              content: chunk[chunk.length - 1].document.content + '\n' + n.total
            }
          }
          if (lapLNum > index && index + lapRNum >= nodes.length) {
            break
          }
        }
      } else {
        const pushContent = async (contents: string[]) => {
          for (let i = 0; i < contents.length; i++) {
            const content = contents[i]
            chunk.push({
              indexes: [{ value: content }, { value: title }],
              document: { content }
            })
            if (options.useLM) {
              const index = chunk.length - 1
              chunkTask.push(index)
              console.log('task', index)
              // TODO: 这里使用大模型，由于时间问题后续需要加上进度功能
              getQuestionsByLM(content).then((questions) => {
                questions.forEach((question) => {
                  chunk[index].indexes.push({ value: question })
                })
                chunkTask.splice(chunkTask.indexOf(index), 1)
              })
            }
          }
        }
        if (!node.children?.length) {
          const contents = split(node.total, chunkSize)
          pushContent(contents)
          return
        }
        // 处理子节点之前将当前节点内容加入
        if (node.content) {
          const contents = split(node.content, chunkSize)
          pushContent(contents)
        }
        for (let i = 0; i < node.children.length; i++) {
          dfs(node.children, i, {
            titleBefore: title
          })
        }
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      dfs(nodes, i)
    }
    // 等待所有任务完成,或超时（60s）
    let timeout = 60 * 1000
    while (chunkTask.length && timeout > 0) {
      console.log('wait', chunkTask)
      // sleep(100)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      timeout -= 1000
    }
    return chunk
}
  
  
(function() {
    const md = readFileSync(path.resolve(__dirname, '../md_file/file.md'), 'utf-8')
    getChunkFromNodes(createTreeFromMarkdown(md), {
        chunkSize: 700,
        chunkOverlap: 2,
        useLM: true
    }).then(chunks => {
        writeFileSync(path.resolve(__dirname, '../json_file/chunks.json'), JSON.stringify(chunks.map((chunk)=> ({
            questions: chunk.indexes,  
            ans: chunk.document
        }))))
    })
})()