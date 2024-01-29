import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'
import { config } from 'dotenv';
config()
export async function lmInvoke(option: { system?: string; content: string }): Promise<string> {
    const lm =  new ChatOpenAI({
        streaming: true,
        modelName: 'gpt-3.5-turbo-1106',
        openAIApiKey: process.env.OPENAI_API_KEY,
        temperature: 0.7,
        configuration: {
          baseURL: 'https://api.chatanywhere.tech/v1'
        }
      })
    if (!lm) {
      throw new Error('no model')
    }
    const msgs = [new HumanMessage(option.content)]
    if (option.system) msgs.unshift(new SystemMessage(option.system))
    return (await lm.invoke(msgs)).content as string
}