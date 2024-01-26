import { dirname } from 'path'
import { fileURLToPath } from 'url';

// 在ES模块中，import.meta.url 提供了当前模块文件的URL
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = dirname(__filename);