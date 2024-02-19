import markdownIt, { Token } from "markdown-it";
import { lmInvoke } from "./langchain";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { __dirname } from "./util";
import path from "path";
const md = markdownIt();

interface Node {
  markup: string;
  title: string;
  content: string;
  total: string;
  children: Node[];
}

const splice = (a: string, b: string) => {
  b = (b || '')
  if (a.length) {
    return a + "\n" + b;
  }
  return b;
};

export function createTreeFromMarkdown(
  markdown: string,
  config?: {
    titleMaxLength?: number;
  }
): Node[] {
  const tree: Node[] = [];
  const tokens: Token[] = md.parse(markdown, {});
  let tokenIndex = 0;
  const isType = (tokenType: string) => {
    return tokens[tokenIndex].type === tokenType;
  };
  const getTitle = (str: string) => {
    str = str.trim().split("\n")[0];
    return str.slice(0, config?.titleMaxLength || 150);
  };
  const contentProcess = (): string => {
    if (isType("list_item_open")) {
      let content = "";
      content += "\n" + tokens[tokenIndex].info + tokens[tokenIndex].markup + " ";
      while (tokenIndex < tokens.length && !isType("list_item_close")) {
        tokenIndex++;
        content += tokens[tokenIndex].content ? tokens[tokenIndex].content + "\n" : "";
      }
      return content.slice(0, -1);
    }
    if (isType("inline")) return "\n" + tokens[tokenIndex].content;
    if (isType("fence")) {
      const fence = tokens[tokenIndex];
      return (
        "\n" + fence.markup + fence.info + "\n" + fence.content + fence.markup
      );
    }
    if (tokens[tokenIndex].type === "table_open") {
      let isInsideRow = false,currentRow = "",tableMarkdown = "", isHeader = false,  headerNum = 0
      for (; tokenIndex < tokens.length; tokenIndex++) {
        const token = tokens[tokenIndex];
        if (token.type === "table_close") break;
        if (token.type === "tr_open") {
          isInsideRow = true; currentRow = "|";
        } else if (token.type === "tr_close") {
          isInsideRow = false;
          tableMarkdown += currentRow.trim() + "\n";
          if(!isHeader) {
            isHeader = true;
            for(let i = 0; i < headerNum; i++) tableMarkdown += '|-'
            tableMarkdown += '|\n'
          }
        } else if (
          isInsideRow &&
          (token.type === "th_open" || token.type === "td_open")
        ) {
          if (token.type === "th_open" && !isHeader) headerNum++
        } else if (
          isInsideRow &&
          (token.type === "th_close" || token.type === "td_close")
        ) {
          currentRow += "|";
        } else if (isInsideRow) {
          currentRow += contentProcess().slice(1);
        }
      }
      return "\n" + tableMarkdown.slice(0, -1);
    }
    return "";
  };
  let beforeContent = "";
  while (tokenIndex < tokens.length && !isType("heading_open")) {
    beforeContent += contentProcess();
    tokenIndex++;
  }
  beforeContent &&
    tree.push({
      markup: "",
      title: getTitle(beforeContent),
      content: beforeContent,
      total: beforeContent,
      children: [],
    });
  const buildTree = (options: {
    nodes: Node[];
    level: number;
    totalBefore: string;
  }) => {
    let { nodes, level, totalBefore } = options;
    while (tokenIndex < tokens.length) {
      if (!isType("heading_open")) {
        tokenIndex++;
        continue;
      }
      const markup = tokens[tokenIndex].markup;
      let content = "";
      while (tokenIndex < tokens.length && !isType("heading_close")) {
        tokenIndex++;
        content += tokens[tokenIndex].content;
      }
      const title = content;
      content = markup + " " + content;
      while (tokenIndex < tokens.length && !isType("heading_open")) {
        content += contentProcess();
        tokenIndex++;
      }
      const node = {
        markup,
        title: getTitle(title),
        content: content,
        total: "",
        children: [],
      };
      nodes.push(node);
      if (tokenIndex >= tokens.length) {
        node.total = content;
        return splice(totalBefore, content);
      }
      const levelNext = parseInt(tokens[tokenIndex].tag.slice(1));
      if (levelNext > level) {
        node.total = buildTree({
          nodes: node.children,
          level: levelNext,
          totalBefore: content,
        });
        totalBefore = splice(totalBefore, node.total);
        continue;
      } else if (levelNext === level) {
        node.total = content;
        totalBefore = splice(totalBefore, content);
        continue;
      }
      node.total = content;
      return splice(totalBefore, content);
    }
    return totalBefore;
  };
  while (tokenIndex < tokens.length) {
    buildTree({
      nodes: tree,
      level: parseInt(tokens[tokenIndex].tag.slice(1)),
      totalBefore: "",
    });
  }
  return tree;
}

async function getQuestionsByLM(total: string): Promise<string[]> {
  const content = (
    await lmInvoke({
      system: `我将会给你一段文字，请你根据内容提出几个问题，使用序号标出。例如我给出『小明是一个学生，他喜欢打羽毛球。』，你将回复：
  1. 小明是什么职业 
  2. 小明的爱好是什么。
  提出问题时不要延伸提问，并且确保内容可以明确的回答提出的问题；回复除了问题外不要添加任何其他内容。`,
      content: total,
    })
  ).trim();
  const lines: string[] = [];
  content.split("\n").forEach((line) => {
    // 判断是否以序号开头，如果是则认为该行是问题，去除序号
    if (line.match(/^[0-9]+\./)) {
      line = line.replace(/^[0-9]+\./, "");
      line && lines.push(line);
    }
  });
  return lines;
}

export interface Chunk {
  // indexes 含有以下索引：1.其所有祖先的标题+自身标题 2.当前标题下内容 3.当前标题和子标题下所有内容 4. 大模型根据2的提问
  indexes: { value: string }[];
  document: { content: string };
  from?: string;
}

export async function getChunkFromNodes(
  nodes: Node[],
  options: {
    chunkSize: number;
    chunkOverlap: number;
    useLM?: boolean;
    from?: string;
  } = {
    chunkSize: 700,
    chunkOverlap: 2, // 左右两个节点
  }
): Promise<Chunk[]> {
  const chunk: Chunk[] = [];
  const { chunkSize, chunkOverlap } = options;
  const chunkTask: number[] = [];
  const split = (total: string, size: number) => {
    if (total.match(/```/)) {
      return [total];
    } else {
      // 拆分成chunkSize大小
      const lines = total.split("\n");
      if (lines.length <= 1) {
        // 以size切分lines[0]
        const contents: string[] = [];
        while (lines[0].length > size) {
          const content = lines[0].slice(0, size);
          contents.push(content);
          lines[0] = lines[0].slice(size);
        }
        contents.push(lines[0]);
        return contents;
      }
      let content = "",
        contents: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (content.length + lines[i].length > size) {
          contents.push(content);
          content = "";
        }
        content += lines[i] + "\n";
        if (i === lines.length - 1) {
          contents.push(content);
        }
      }
      return contents;
    }
  };
  const processTitle = (titles: string): string => {
    return titles
      .split("\n")
      .reduce((prev, curr) => {
        return prev + " " + curr.trim().replace(/(^#+) /, "");
      }, "")
      .trim();
  };

  const dfs = (
    nodes: Node[],
    index: number,
    data?: {
      titleBefore: string;
    }
  ) => {
    const node = nodes[index];
    const totalTitle = splice(
      data?.titleBefore ? data?.titleBefore : "",
      node.markup + " " + node.title
    );
    if (node.total.length < chunkSize) {
      chunk.push({
        indexes: [{ value: processTitle(totalTitle) }],
        document: { content: splice(data?.titleBefore ?? "", node.total) },
        from: options.from,
      });
      if (node.title !== node.content)
        chunk[chunk.length - 1].indexes.push({ value: node.content });
      if (node.title !== node.total)
        chunk[chunk.length - 1].indexes.push({ value: node.total });
      // TODO: 这里使用大模型，由于时间问题后续需要加上进度功能
      if (options.useLM) {
        const index = chunk.length - 1;
        chunkTask.push(index);
        getQuestionsByLM(node.total).then((questions) => {
          questions.forEach((question) => {
            chunk[index].indexes.push({ value: question });
          });
          chunkTask.splice(chunkTask.indexOf(index), 1);
        });
      }
      // TODO: 尝试加上 chunkOverlap 是否有效果
      let lapLNum = 0,
        lapRNum = 0;
      while (lapLNum + lapRNum < chunkOverlap) {
        lapLNum++;
        if (lapLNum <= index) {
          const n = nodes[index - lapLNum];
          if (
            (chunk[chunk.length - 1].document.content + "\n" + n.total).length >
            chunkSize
          )
            break;
          chunk[chunk.length - 1].document = {
            content: n.total + "\n" + chunk[chunk.length - 1].document.content,
          };
          if (lapLNum + lapRNum === chunkOverlap) break;
        }
        lapRNum++;
        if (index + lapRNum < nodes.length) {
          const n = nodes[index + lapRNum];
          if (
            (chunk[chunk.length - 1].document.content + "\n" + n.total).length >
            chunkSize
          )
            break;
          chunk[chunk.length - 1].document = {
            content: chunk[chunk.length - 1].document.content + "\n" + n.total,
          };
        }
        if (lapLNum > index && index + lapRNum >= nodes.length) {
          break;
        }
      }
    } else {
      const pushContent = async (contents: string[]) => {
        for (let i = 0; i < contents.length; i++) {
          const content = contents[i].startsWith(node.markup + ' ') ? splice(data?.titleBefore ?? "", contents[i]) : splice(totalTitle, contents[i]);
          chunk.push({
            indexes: [{ value: content }, { value: processTitle(totalTitle) }],
            document: { content },
            from: options.from,
          });
          if (options.useLM) {
            const index = chunk.length - 1;
            chunkTask.push(index);
            // TODO: 这里使用大模型，由于时间问题后续需要加上进度功能
            getQuestionsByLM(content).then((questions) => {
              questions.forEach((question) => {
                chunk[index].indexes.push({ value: question });
              });
              chunkTask.splice(chunkTask.indexOf(index), 1);
            });
          }
        }
      };
      if (!node.children?.length) {
        const contents = split(node.total, chunkSize);
        pushContent(contents);
        return;
      }
      // 处理子节点之前将当前节点内容加入
      if (node.content) {
        const contents = split(node.content, chunkSize);
        pushContent(contents);
      }
      for (let i = 0; i < node.children.length; i++) {
        dfs(node.children, i, {
          titleBefore: totalTitle,
        });
      }
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    dfs(nodes, i);
  }
  // 等待所有任务完成,或超时（60s）
  let timeout = 60 * 1000;
  while (chunkTask.length && timeout > 0) {
    console.log("wait", chunkTask);
    // sleep(100)
    await new Promise((resolve) => setTimeout(resolve, 1000));
    timeout -= 1000;
  }
  return chunk;
}

(function () {
  const md = readFileSync(
    path.resolve(__dirname, "../md_file/file.md"),
    "utf-8"
  );
  if (!existsSync(path.resolve(__dirname, "../json_file")))
    mkdirSync(path.resolve(__dirname, "../json_file"));
  const nodes = createTreeFromMarkdown(md);
  writeFileSync(
    path.resolve(__dirname, "../json_file/tree.json"),
    JSON.stringify(nodes)
  );
  getChunkFromNodes(nodes, {
    chunkSize: 700,
    chunkOverlap: 0,
    useLM: false,
  }).then((chunks) => {
    writeFileSync(
      path.resolve(__dirname, "../json_file/chunks.json"),
      JSON.stringify(
        chunks.map((chunk) => ({
          questions: chunk.indexes,
          ans: chunk.document,
        }))
      )
    );
  });
})();
